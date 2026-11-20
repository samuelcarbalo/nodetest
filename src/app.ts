import express, { type Express } from "express";

import { errorHandler } from "./middlewares/error-handler.js";
import { notFound } from "./middlewares/not-found.js";
import { validationsRouter } from "./routes/validations.js";
import type { ValidationService } from "./services/validations.service.js";

export function createApp(service: ValidationService): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  app.use(validationsRouter(service));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
