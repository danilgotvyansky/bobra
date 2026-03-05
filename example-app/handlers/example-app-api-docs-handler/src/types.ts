import { type AppEnvBindings } from '@bobra/framework/db';

export interface Env extends AppEnvBindings {
  // Additional bindings can be added here if needed
}

export interface ServiceDiscovery {
  assignedHandlers: string[];
  initializedHandlers: string[];
  availableServiceBindings: Array<{
    binding: string;
    service: string;
    external_url?: string;
  }>;
}
