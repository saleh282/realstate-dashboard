import mongoose, { Types } from 'mongoose';
import { AuditLogService } from '../../src/audit/audit-log.service';
import { AuditLogSchema } from '../../src/audit/schemas/audit-log.schema';
import { PropertyFormDefinitionSchema } from '../../src/property-form-definitions/schemas/property-form-definition.schema';
import { PropertyFormDefinitionVersionSchema } from '../../src/property-form-definitions/schemas/property-form-definition-version.schema';
import { matches, sortDocs, type Doc } from './memory-mongo';

/**
 * Transactional in-memory MongoDB for the DPF-030..032 Admin lifecycle: a
 * snapshot per transaction, buffered writes applied only on commit (abort
 * discards them), single-writer-per-document WriteConflict (a document
 * written by another open transaction, or committed after this snapshot),
 * the four FormDefinition unique indexes, the version schema's query-update
 * state narrowing, and the real head/version/audit schemas validating every
 * stored document (offline). A MODEL of MongoDB: real-Mongo qualification
 * remains the authority.
 */

type Coll = 'definitions' | 'versions' | 'attributes' | 'types' | 'audit';
type Txn = { id: number; active: boolean; snapshot: Record<Coll, Map<string, Doc>>; stamps: Map<string, number>; writes: Record<Coll, Map<string, Doc | null>> };
export type WriteEvent = { collection: Coll; kind: 'insert' | 'update' | 'delete'; transaction: number | null; filter?: Doc; update?: Doc };

const COLLS: Coll[] = ['definitions', 'versions', 'attributes', 'types', 'audit'];
const HeadModel = mongoose.models.FakeFormHead ?? mongoose.model('FakeFormHead', PropertyFormDefinitionSchema);
const VersionModel = mongoose.models.FakeFormVersion ?? mongoose.model('FakeFormVersion', PropertyFormDefinitionVersionSchema);
const AuditModel = mongoose.models.FakeFormAudit ?? mongoose.model('FakeFormAudit', AuditLogSchema);
const SCHEMAS: Partial<Record<Coll, mongoose.Model<any>>> = { definitions: HeadModel, versions: VersionModel, audit: AuditModel };

export const writeConflict = (message = 'WriteConflict') => Object.assign(new Error(message), { code: 112, hasErrorLabel: (label: string) => label === 'TransientTransactionError' });
const duplicateKey = (index: string) => Object.assign(new Error(`E11000 duplicate key error collection index: ${index}`), { code: 11000, keyPattern: {} });

export function clone<T>(value: T): T {
  if (value instanceof Types.ObjectId || value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map(clone) as T;
  return Object.fromEntries(Object.entries(value as Doc).map(([key, item]) => [key, clone(item)])) as T;
}

const key = (value: unknown) => String(value).toLowerCase();

export class FakeFormMongo {
  readonly data: Record<Coll, Map<string, Doc>> = { definitions: new Map(), versions: new Map(), attributes: new Map(), types: new Map(), audit: new Map() };
  /** Commit counter per document (`coll:id`), for the stale-snapshot check. */
  private readonly stamps = new Map<string, number>();
  private readonly locks = new Map<string, number>();
  private nextTxn = 1;
  readonly writes: WriteEvent[] = [];
  transactions = 0;
  commits = 0;
  aborts = 0;
  /** Failure injection: return an error to throw instead of performing a write. */
  failWrite?: (event: WriteEvent) => Error | undefined;
  failCommit?: (transaction: number) => Error | undefined;
  /** Awaited before every operation; lets a spec interleave two transactions. */
  gate?: (event: { collection: Coll; op: string; transaction: number | null }) => Promise<void>;
  readonly audit: AuditLogService;

  constructor() {
    this.audit = new AuditLogService(this.model('audit') as any);
  }

  seed(collection: Coll, docs: Doc[]) {
    for (const doc of docs) {
      const stored = clone({ _id: new Types.ObjectId(), ...doc });
      this.data[collection].set(key(stored._id), stored);
      this.stamps.set(`${collection}:${key(stored._id)}`, 1);
    }
    return this;
  }

  rows(collection: Coll): Doc[] { return [...this.data[collection].values()].map(clone); }
  get(collection: Coll, id: unknown): Doc | undefined { const doc = this.data[collection].get(key(id)); return doc ? clone(doc) : undefined; }

  get connection() {
    return { startSession: async () => this.session() };
  }

  models() {
    return { definitions: this.model('definitions'), versions: this.model('versions'), attributes: this.model('attributes'), types: this.model('types') };
  }

  /** The Phase-3/4 model names, for PropertyFormDefinitionsService and PropertiesService. */
  formModels() {
    return { formDefinitions: this.model('definitions'), formVersions: this.model('versions') };
  }

  // ------------------------------------------------------------ sessions

  private session() {
    const mongo = this;
    let txn: Txn | undefined;
    return {
      startTransaction() {
        mongo.transactions += 1;
        const snapshot = Object.fromEntries(COLLS.map((coll) => [coll, new Map([...mongo.data[coll]].map(([id, doc]) => [id, clone(doc)]))])) as Record<Coll, Map<string, Doc>>;
        txn = { id: mongo.nextTxn++, active: true, snapshot, stamps: new Map(mongo.stamps), writes: Object.fromEntries(COLLS.map((coll) => [coll, new Map()])) as any };
      },
      inTransaction() { return Boolean(txn?.active); },
      async commitTransaction() {
        if (!txn?.active) throw new Error('no active transaction');
        const failure = mongo.failCommit?.(txn.id);
        if (failure) { mongo.release(txn); txn.active = false; mongo.aborts += 1; throw failure; }
        for (const coll of COLLS) {
          for (const [id, doc] of txn.writes[coll]) {
            const stamp = `${coll}:${id}`;
            if ((mongo.stamps.get(stamp) ?? 0) !== (txn.stamps.get(stamp) ?? 0)) { mongo.release(txn); txn.active = false; mongo.aborts += 1; throw writeConflict('stale snapshot at commit'); }
          }
        }
        for (const coll of COLLS) {
          for (const [id, doc] of txn.writes[coll]) {
            if (doc === null) continue;
            const committedOthers = [...mongo.data[coll].values()].filter((other) => key(other._id) !== id && !(txn!.writes[coll].has(key(other._id))));
            const clash = mongo.indexKeys(coll, doc).find((indexKey) => committedOthers.some((other) => mongo.indexKeys(coll, other).includes(indexKey)));
            if (clash) { mongo.release(txn); txn.active = false; mongo.aborts += 1; throw duplicateKey(clash.split(':')[0]); }
          }
        }
        for (const coll of COLLS) {
          for (const [id, doc] of txn.writes[coll]) {
            if (doc === null) mongo.data[coll].delete(id); else mongo.data[coll].set(id, clone(doc));
            mongo.stamps.set(`${coll}:${id}`, (mongo.stamps.get(`${coll}:${id}`) ?? 0) + 1);
          }
        }
        mongo.release(txn);
        txn.active = false;
        mongo.commits += 1;
      },
      async abortTransaction() {
        if (txn?.active) { mongo.release(txn); txn.active = false; mongo.aborts += 1; }
      },
      async endSession() { if (txn?.active) { mongo.release(txn); txn.active = false; mongo.aborts += 1; } },
      get __txn() { return txn; },
    };
  }

  private release(txn: Txn) { for (const [id, owner] of this.locks) if (owner === txn.id) this.locks.delete(id); }

  private view(coll: Coll, txn?: Txn): Doc[] {
    if (!txn) return [...this.data[coll].values()];
    const merged = new Map(txn.snapshot[coll]);
    for (const [id, doc] of txn.writes[coll]) { if (doc === null) merged.delete(id); else merged.set(id, doc); }
    return [...merged.values()];
  }

  private lock(coll: Coll, id: string, txn?: Txn) {
    if (!txn) return;
    const stamp = `${coll}:${id}`;
    const owner = this.locks.get(stamp);
    if (owner !== undefined && owner !== txn.id) throw writeConflict('document is being written by another transaction');
    if ((this.stamps.get(stamp) ?? 0) !== (txn.stamps.get(stamp) ?? 0)) throw writeConflict('document changed since the snapshot');
    this.locks.set(stamp, txn.id);
  }

  private put(coll: Coll, doc: Doc | null, id: string, txn?: Txn) {
    if (txn) { txn.writes[coll].set(id, doc === null ? null : clone(doc)); return; }
    if (doc === null) this.data[coll].delete(id); else this.data[coll].set(id, clone(doc));
    this.stamps.set(`${coll}:${id}`, (this.stamps.get(`${coll}:${id}`) ?? 0) + 1);
  }

  /** Unique index keys a document occupies. */
  private indexKeys(coll: Coll, doc: Doc): string[] {
    if (coll === 'definitions') return [`property_form_definition_subcategory_unique:${key(doc.purposeSubcategoryId)}`];
    if (coll !== 'versions') return [];
    return [
      ...(doc.version !== undefined ? [`property_form_version_number_unique:${key(doc.definitionId)}:${doc.version}`] : []),
      ...(doc.state === 'draft' ? [`property_form_version_one_draft:${key(doc.definitionId)}`] : []),
      ...(doc.state === 'published' ? [`property_form_version_one_published:${key(doc.definitionId)}`] : []),
    ];
  }

  /**
   * Unique indexes, checked against this transaction's view and against
   * committed data. An index key another open transaction has written is a
   * WriteConflict, as in MongoDB (the key is locked until that commit/abort).
   */
  private assertUnique(coll: Coll, doc: Doc, txn?: Txn) {
    if (txn) {
      for (const indexKey of this.indexKeys(coll, doc)) {
        const owner = this.locks.get(`index:${indexKey}`);
        if (owner !== undefined && owner !== txn.id) throw writeConflict('unique index key is being written by another transaction');
        this.locks.set(`index:${indexKey}`, txn.id);
      }
    }
    // This transaction's view wins; committed documents it never saw (inserted after its snapshot) still collide.
    const merged = new Map([...this.data[coll]].filter(([id]) => !txn || !txn.writes[coll].has(id)));
    for (const other of this.view(coll, txn)) merged.set(key(other._id), other);
    const others = [...merged.values()].filter((other) => key(other._id) !== key(doc._id));
    const same = (field: string) => (other: Doc) => key(other[field]) === key(doc[field]);
    if (coll === 'definitions' && others.some(same('purposeSubcategoryId'))) throw duplicateKey('property_form_definition_subcategory_unique');
    if (coll === 'versions') {
      const sameDefinition = others.filter(same('definitionId'));
      if (doc.version !== undefined && sameDefinition.some((other) => other.version === doc.version)) throw duplicateKey('property_form_version_number_unique');
      if (doc.state === 'draft' && sameDefinition.some((other) => other.state === 'draft')) throw duplicateKey('property_form_version_one_draft');
      if (doc.state === 'published' && sameDefinition.some((other) => other.state === 'published')) throw duplicateKey('property_form_version_one_published');
    }
  }

  private async validate(coll: Coll, doc: Doc) {
    const Model = SCHEMAS[coll];
    if (Model) await new Model(clone(doc)).validate();
  }

  private beforeWrite(event: WriteEvent) {
    this.writes.push(event);
    const failure = this.failWrite?.(event);
    if (failure) throw failure;
  }

  // ------------------------------------------------------------ models

  private model(coll: Coll) {
    const mongo = this;
    const txnOf = (session: any): Txn | undefined => (session?.__txn?.active ? session.__txn : undefined);
    const query = (op: string, run: (txn?: Txn) => Promise<unknown> | unknown) => {
      let session: any;
      let sort: Record<string, 1 | -1> | undefined;
      const chain: any = {
        session(value: any) { session = value; return chain; },
        sort(spec: Record<string, 1 | -1>) { sort = spec; return chain; },
        select() { return chain; },
        lean() { return chain; },
        setOptions() { return chain; },
        async exec() {
          const txn = txnOf(session);
          await mongo.gate?.({ collection: coll, op, transaction: txn?.id ?? null });
          const result = await run(txn);
          if (sort && Array.isArray(result)) return sortDocs(result, sort).map(clone);
          return clone(result);
        },
        then(resolve: any, reject: any) { return chain.exec().then(resolve, reject); },
      };
      return chain;
    };
    const find = (filter: Doc, txn?: Txn) => mongo.view(coll, txn).filter((doc) => matches(doc, filter));
    const narrow = (filter: Doc, update: Doc): Doc => {
      if (coll !== 'versions') return filter;
      // Mirrors PropertyFormDefinitionVersionSchema's query-update hook.
      const nextState = update.$set?.state;
      const paths = [...Object.keys(update.$set ?? {}), ...Object.keys(update.$unset ?? {}), ...Object.keys(update.$inc ?? {})];
      const content = paths.filter((path) => !['state', 'supersededAt', 'updatedAt'].includes(path));
      if (nextState === 'draft' || (update.$unset && 'state' in update.$unset)) throw new Error('PROPERTY_FORM_VERSION_INVARIANT: state');
      if (nextState === 'superseded') { if (content.length) throw new Error('PROPERTY_FORM_VERSION_INVARIANT: superseding'); return { $and: [filter, { state: 'published' }] }; }
      if (content.length || nextState === 'published') return { $and: [filter, { state: 'draft' }] };
      return filter;
    };
    const apply = (doc: Doc, update: Doc) => {
      const next = clone(doc);
      Object.assign(next, clone(update.$set ?? {}));
      for (const path of Object.keys(update.$unset ?? {})) delete next[path];
      for (const [path, amount] of Object.entries(update.$inc ?? {})) next[path] = (next[path] ?? 0) + (amount as number);
      next.updatedAt = new Date();
      return next;
    };
    const update = async (filter: Doc, change: Doc, txn: Txn | undefined) => {
      mongo.beforeWrite({ collection: coll, kind: 'update', transaction: txn?.id ?? null, filter, update: change });
      if (coll === 'definitions') {
        for (const counter of ['nextVersionNumber', 'version']) {
          if (change.$set?.[counter] !== undefined) throw new Error(`PROPERTY_FORM_DEFINITION_INVARIANT: ${counter} changes only through $inc`);
          if (change.$inc?.[counter] !== undefined && !(change.$inc[counter] > 0)) throw new Error(`PROPERTY_FORM_DEFINITION_INVARIANT: ${counter} only increases`);
        }
      }
      const target = find(narrow(filter, change), txn)[0];
      if (!target) return null;
      mongo.lock(coll, key(target._id), txn);
      const next = apply(target, change);
      await mongo.validate(coll, next);
      mongo.assertUnique(coll, next, txn);
      mongo.put(coll, next, key(target._id), txn);
      return next;
    };
    return {
      find: (filter: Doc = {}) => query('find', (txn) => find(filter, txn)),
      findOne: (filter: Doc = {}) => query('findOne', (txn) => find(filter, txn)[0] ?? null),
      findById: (id: unknown) => query('findById', (txn) => find({ _id: id }, txn)[0] ?? null),
      exists: (filter: Doc) => query('exists', (txn) => (find(filter, txn)[0] ? { _id: find(filter, txn)[0]._id } : null)),
      countDocuments: (filter: Doc = {}) => query('countDocuments', (txn) => find(filter, txn).length),
      async create(docs: Doc | Doc[], options: { session?: any } = {}) {
        const txn = txnOf(options.session);
        await mongo.gate?.({ collection: coll, op: 'create', transaction: txn?.id ?? null });
        const created: Doc[] = [];
        for (const input of Array.isArray(docs) ? docs : [docs]) {
          mongo.beforeWrite({ collection: coll, kind: 'insert', transaction: txn?.id ?? null });
          const now = new Date();
          const Model = SCHEMAS[coll];
          // Defaults exactly as the schema applies them (a created document is a full Mongoose document).
          const doc = Model ? new Model(clone({ ...input })).toObject() : clone({ _id: new Types.ObjectId(), ...input });
          if (coll !== 'audit') Object.assign(doc, { createdAt: doc.createdAt ?? now, updatedAt: doc.updatedAt ?? now }); else doc.createdAt = now;
          delete doc.__v;
          await mongo.validate(coll, doc);
          mongo.lock(coll, key(doc._id), txn);
          if (find({ _id: doc._id }, txn).length || mongo.data[coll].has(key(doc._id))) throw duplicateKey('_id_');
          mongo.assertUnique(coll, doc, txn);
          mongo.put(coll, doc, key(doc._id), txn);
          created.push({ ...clone(doc), toObject: () => clone(doc) });
        }
        return Array.isArray(docs) ? created : created[0];
      },
      findOneAndUpdate: (filter: Doc, change: Doc, _options: Doc = {}) => {
        const chain = query('findOneAndUpdate', (txn) => update(filter, change, txnOf(_options.session) ?? txn));
        return chain;
      },
      updateOne: (filter: Doc, change: Doc) => query('updateOne', async (txn) => {
        const next = await update(filter, change, txn);
        return { matchedCount: next ? 1 : 0, modifiedCount: next ? 1 : 0 };
      }),
      deleteOne: (filter: Doc) => query('deleteOne', async (txn) => {
        mongo.beforeWrite({ collection: coll, kind: 'delete', transaction: txn?.id ?? null, filter });
        // Mirrors the version schema's delete hook: only drafts can be discarded; heads are never deleted.
        if (coll === 'definitions') throw new Error('PROPERTY_FORM_DEFINITION_INVARIANT: heads are never deleted');
        const target = find(coll === 'versions' ? { $and: [filter, { state: 'draft' }] } : filter, txn)[0];
        if (!target) return { deletedCount: 0 };
        mongo.lock(coll, key(target._id), txn);
        mongo.put(coll, null, key(target._id), txn);
        return { deletedCount: 1 };
      }),
    };
  }
}
