import { z } from "zod";

const dynamoEnvSchema = z.object({
  DYNAMODB_ENDPOINT: z.string().url(),
  DYNAMODB_REGION: z.string().min(1).default("us-east-1"),
  DYNAMODB_AUDIT_TABLE: z.string().min(1).default("audit_events"),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
});

export type DynamoEnv = z.infer<typeof dynamoEnvSchema>;

export function loadDynamoEnv(source: NodeJS.ProcessEnv = process.env): DynamoEnv {
  return parseEnv(dynamoEnvSchema, source, "DynamoDB");
}

const appEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGODB_URI: z.string().min(1),
  MONGODB_DB: z.string().min(1).default("auco"),
  // Vacía o ausente: el proceso arranca y el enriquecimiento queda degradado.
  CSC_API_KEY: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim() ?? "";
      return trimmed.length > 0 ? trimmed : undefined;
    }),
  COUNTRIES_API_BASE_URL: z.string().url().default("https://api.countrystatecity.in/v1"),
  COUNTRIES_API_TIMEOUT_MS: z.coerce.number().int().min(1).max(30_000).default(3_000),
});

export type AppEnv = z.infer<typeof appEnvSchema>;

export function loadAppEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  return parseEnv(appEnvSchema, source, "application");
}

function parseEnv<Schema extends z.ZodTypeAny>(
  schema: Schema,
  source: NodeJS.ProcessEnv,
  label: string,
): z.infer<Schema> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid ${label} environment: ${message}`);
  }
  return parsed.data;
}
