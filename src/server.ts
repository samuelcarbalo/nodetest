import { createApp } from "./app.js";
import { createDocumentClient, createDynamoDbClient } from "./config/dynamodb.js";
import { loadAppEnv, loadDynamoEnv } from "./config/env.js";
import { connectMongo } from "./config/mongodb.js";
import { DynamoAuditLog } from "./repositories/dynamodb/audit-log.js";
import { ensureAuditTable } from "./repositories/dynamodb/audit-table.js";
import { createValidationRepository } from "./repositories/mongodb/validations.repository.js";
import { CountriesClient } from "./services/countries-client.js";
import { ValidationService } from "./services/validations.service.js";

async function main(): Promise<void> {
  const env = loadAppEnv();
  const dynamoEnv = loadDynamoEnv();
  const mongo = await connectMongo(env);
  const repository = createValidationRepository(mongo.db);
  await repository.ensureIndexes();

  const dynamo = createDynamoDbClient(dynamoEnv);
  const documents = createDocumentClient(dynamo);
  await ensureAuditTable(dynamo, dynamoEnv.DYNAMODB_AUDIT_TABLE);

  const app = createApp(
    new ValidationService(
      new CountriesClient(env.COUNTRIES_API_BASE_URL, env.COUNTRIES_API_TIMEOUT_MS, env.CSC_API_KEY),
      repository,
      new DynamoAuditLog(documents, dynamoEnv.DYNAMODB_AUDIT_TABLE),
    ),
  );
  const server = app.listen(env.PORT, () => {
    console.log(`API escuchando en el puerto ${env.PORT}`);
  });

  const shutdown = (signal: string) => {
    console.log(`cerrando (${signal})`);
    server.close(() => {
      documents.destroy();
      void mongo.client.close().finally(() => process.exit(0));
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    console.error("unhandledRejection", reason);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
