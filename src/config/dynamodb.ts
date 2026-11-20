import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import type { DynamoEnv } from "./env.js";

export function createDynamoDbClient(env: DynamoEnv): DynamoDBClient {
  return new DynamoDBClient({
    region: env.DYNAMODB_REGION,
    endpoint: env.DYNAMODB_ENDPOINT,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

export function createDocumentClient(client: DynamoDBClient): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  });
}
