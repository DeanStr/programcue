import { IntegrationExportWorkflows } from "./integration-export-workflows.server";
export {
  IntegrationStateError,
  configureIntegrationConnectionSchema,
  integrationMappingInputSchema,
  integrationRunMessageSchema,
  type IntegrationApiActor,
  type IntegrationPlanChange,
  type IntegrationPlanItem,
} from "./integration-service-foundation.server";

export class IntegrationService extends IntegrationExportWorkflows {}
