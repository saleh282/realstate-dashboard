import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

const uri = process.env.MONGO_URI;

if (!uri) {
  throw new Error('MONGO_URI is required');
}

const EXPECTED_HOST = 'cluster0.jepfa3a.mongodb.net';
const EXPECTED_DB = 'real-estate-auction';

const parsed = new URL(uri);

if (parsed.hostname !== EXPECTED_HOST) {
  throw new Error(`Refused: unexpected Mongo host ${parsed.hostname}`);
}

if (process.env.NODE_ENV === 'production') {
  throw new Error('Refused: NODE_ENV=production');
}

const mode = process.argv.includes('--post-legacy')
  ? 'post-legacy'
  : 'pre-legacy';

const client = new MongoClient(uri);

async function main() {
  await client.connect();
  const db = client.db(EXPECTED_DB);

  const admin = await db.collection('users').findOne({
    systemRole: 'SUPER_ADMIN',
  });

  if (!admin?._id) {
    throw new Error('A SUPER_ADMIN must exist before catalog seeding');
  }

  const actorId = admin._id as ObjectId;

  const purposes = [
    {
      code: 'residential',
      nameAr: 'سكني',
      nameEn: 'Residential',
      descriptionAr: 'العقارات المخصصة للسكن',
      sortOrder: 1,
    },
    {
      code: 'commercial',
      nameAr: 'تجاري',
      nameEn: 'Commercial',
      descriptionAr: 'العقارات والأنشطة التجارية والإدارية',
      sortOrder: 2,
    },
    {
      code: 'industrial',
      nameAr: 'صناعي',
      nameEn: 'Industrial',
      descriptionAr: 'العقارات والمنشآت الصناعية',
      sortOrder: 3,
    },
    {
      code: 'agricultural',
      nameAr: 'زراعي',
      nameEn: 'Agricultural',
      descriptionAr: 'الأراضي والمنشآت الزراعية',
      sortOrder: 4,
    },
  ];

  for (const purpose of purposes) {
    await db.collection('property_purpose_categories').updateOne(
      { code: purpose.code },
      {
        $setOnInsert: {
          ...purpose,
          isActive: true,
          version: 1,
          usageCount: 0,
          createdBy: actorId,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  const purposeDocs = await db
    .collection('property_purpose_categories')
    .find({ code: { $in: purposes.map((p) => p.code) } })
    .toArray();

  const purposeIds = Object.fromEntries(
    purposeDocs.map((p) => [p.code, p._id]),
  );

  const residentialTypes = [
    ['apartment', 'شقة', 'Apartment', 'home', 1],
    ['villa', 'فيلا', 'Villa', 'villa', 2],
    ['house', 'منزل', 'House', 'home', 3],
    ['duplex', 'دوبلكس', 'Duplex', 'home', 4],
    ['penthouse', 'بنتهاوس', 'Penthouse', 'home', 5],
    ['studio', 'استوديو', 'Studio', 'home', 6],
    ['chalet', 'شاليه', 'Chalet', 'home', 7],
  ];

  const additionalTypes = [
    ['shop', 'محل تجاري', 'Shop', 'commercial', 'home', 1],
    ['office', 'مكتب إداري', 'Office', 'commercial', 'home', 2],
    ['clinic', 'عيادة', 'Clinic', 'commercial', 'home', 3],
    [
      'commercial_unit',
      'وحدة تجارية',
      'Commercial Unit',
      'commercial',
      'home',
      4,
    ],
    [
      'commercial_building',
      'مبنى تجاري',
      'Commercial Building',
      'commercial',
      'home',
      5,
    ],
    [
      'commercial_land',
      'أرض تجارية',
      'Commercial Land',
      'commercial',
      'home',
      6,
    ],

    ['factory', 'مصنع', 'Factory', 'industrial', 'home', 1],
    ['warehouse', 'مخزن', 'Warehouse', 'industrial', 'home', 2],
    ['workshop', 'ورشة', 'Workshop', 'industrial', 'home', 3],
    [
      'industrial_land',
      'أرض صناعية',
      'Industrial Land',
      'industrial',
      'home',
      4,
    ],

    [
      'agricultural_land',
      'أرض زراعية',
      'Agricultural Land',
      'agricultural',
      'home',
      1,
    ],
    ['farm', 'مزرعة', 'Farm', 'agricultural', 'home', 2],
  ];

  async function upsertType(
    code: string,
    nameAr: string,
    nameEn: string,
    purposeCode: string,
    iconKey: string,
    sortOrder: number,
  ) {
    await db.collection('property_types').updateOne(
      { code },
      {
        $setOnInsert: {
          code,
          nameAr,
          nameEn,
          iconKey,
          purposeCategoryId: purposeIds[purposeCode],
          isActive: true,
          sortOrder,
          usageCount: 0,
          version: 0,
          createdBy: actorId,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  if (mode === 'pre-legacy') {
    for (const [code, nameAr, nameEn, iconKey, sortOrder] of residentialTypes) {
      await upsertType(
        code as string,
        nameAr as string,
        nameEn as string,
        'residential',
        iconKey as string,
        sortOrder as number,
      );
    }

    const amenities = [
      ['elevator', 'مصعد', 'Elevator', 'elevator', 'service', 1],
      ['parking', 'جراج / موقف', 'Parking', 'parking', 'facility', 2],
      ['security', 'أمن', 'Security', 'security', 'service', 3],
      ['garden', 'حديقة', 'Garden', 'garden', 'feature', 4],
      ['pool', 'حمام سباحة', 'Swimming Pool', 'pool', 'facility', 5],
      ['balcony', 'بلكونة', 'Balcony', 'balcony', 'feature', 6],
      [
        'air_conditioning',
        'تكييف',
        'Air Conditioning',
        'air_conditioning',
        'feature',
        7,
      ],
    ];

    for (const [code, nameAr, nameEn, iconKey, category, sortOrder] of amenities) {
      await db.collection('amenities').updateOne(
        { code },
        {
          $setOnInsert: {
            code,
            nameAr,
            nameEn,
            iconKey,
            category,
            isActive: true,
            sortOrder,
            usageCount: 0,
            createdBy: actorId,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
    }
  }

  if (mode === 'post-legacy') {
    for (const [
      code,
      nameAr,
      nameEn,
      purposeCode,
      iconKey,
      sortOrder,
    ] of additionalTypes) {
      await upsertType(
        code as string,
        nameAr as string,
        nameEn as string,
        purposeCode as string,
        iconKey as string,
        sortOrder as number,
      );
    }
  }

  console.log(`Baseline catalog seed complete (${mode}).`);

  console.log({
    purposes: await db
      .collection('property_purpose_categories')
      .countDocuments({}),
    propertyTypes: await db.collection('property_types').countDocuments({}),
    amenities: await db.collection('amenities').countDocuments({}),
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.close();
  });
