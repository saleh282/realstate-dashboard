import { SetMetadata } from '@nestjs/common';
import { Capability } from './capability';

export const CAPABILITIES_KEY = 'mazad:capabilities';
export const RequireCapabilities = (...capabilities: Capability[]) =>
  SetMetadata(CAPABILITIES_KEY, capabilities);
