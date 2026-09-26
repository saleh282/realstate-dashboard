import { FORM_SCHEMA_VERSION } from './property-form-definition.constants';

/**
 * `?formSchema=1` is sent by clients that render FormDefinitions (frozen §D
 * #1-2, §E1). Read as a single query value (no DTO), so these long-standing
 * public endpoints keep ignoring any other query parameter exactly as before;
 * a missing or unknown value gets the safe old-client view.
 */
export const supportsFormSchema = (formSchema: unknown) => formSchema === FORM_SCHEMA_VERSION;
