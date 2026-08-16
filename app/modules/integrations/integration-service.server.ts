import { IntegrationExportWorkflows } from "./integration-export-workflows.server";

export {
  configureIntegrationConnectionSchema,
  type IntegrationApiActor,
  type IntegrationPlanChange,
  type IntegrationPlanItem,
  IntegrationStateError,
  integrationMappingInputSchema,
  integrationRunMessageSchema,
} from "./integration-service-foundation.server";

export class IntegrationService extends IntegrationExportWorkflows {}
