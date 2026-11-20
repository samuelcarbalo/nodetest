import type { ErrorRequestHandler } from "express";

import { HttpError } from "../domain/http-error.js";

export const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (isJsonParseError(error)) {
    res.status(400).json({
      error: {
        code: "INVALID_JSON",
        message: "El cuerpo no es JSON válido",
      },
    });
    return;
  }

  if (error instanceof HttpError) {
    const body: { code: string; message: string; details?: unknown } = {
      code: error.code,
      message: error.message,
    };
    if (error.details !== undefined && error.status < 500) {
      body.details = error.details;
    }
    res.status(error.status).json({ error: body });
    return;
  }

  if (isMongoUnavailable(error)) {
    res.status(503).json({
      error: {
        code: "DATABASE_UNAVAILABLE",
        message: "La base de datos no está disponible",
      },
    });
    return;
  }

  console.error(error);
  res.status(500).json({
    error: {
      code: "INTERNAL",
      message: "Error inesperado",
    },
  });
};

function isJsonParseError(error: unknown): boolean {
  return error instanceof SyntaxError && "status" in error && error.status === 400;
}

function isMongoUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("name" in error)) {
    return false;
  }
  return (
    error.name === "MongoNetworkError" ||
    error.name === "MongoServerSelectionError" ||
    error.name === "MongoNotConnectedError"
  );
}
