import { MongoClient, type Db } from "mongodb";

import type { AppEnv } from "./env.js";

export type MongoConnection = {
  client: MongoClient;
  db: Db;
};

export async function connectMongo(env: AppEnv): Promise<MongoConnection> {
  const client = new MongoClient(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5_000,
  });
  await client.connect();
  return { client, db: client.db(env.MONGODB_DB) };
}
