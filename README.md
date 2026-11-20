# AUCO

API REST en Express y TypeScript. Guarda validaciones en MongoDB, deja un evento de auditoría en DynamoDB Local y enriquece el país con [CountryStateCity](https://countrystatecity.in/).

## Requisitos

- Node.js 22 o superior
- Docker con Docker Compose

## Bases de datos

Copia el entorno y levanta MongoDB 8 y DynamoDB Local:

```bash
cp .env.example .env
docker compose up -d
```

`docker compose up -d` publica MongoDB en el puerto 27017 y DynamoDB Local en el 8000. Para esperar además a que los healthchecks pasen:

```bash
npm run infra:up
```

| Servicio | Imagen | Puerto |
|---|---|---|
| MongoDB | `mongo:8.0` | `27017` |
| DynamoDB Local | `amazon/dynamodb-local:3.3.2` | `8000` |

Otros comandos:

```bash
npm run infra:logs    # logs de los contenedores
npm run infra:down    # detiene los contenedores
npm run infra:reset   # detiene y borra los volúmenes
```

El usuario de Mongo se crea solo la primera vez, con el volumen vacío. Si cambias `MONGODB_PASSWORD` después, recrea el volumen con `npm run infra:reset`.

## Variables de entorno

Están documentadas en `.env.example`.

| Variable | Uso |
|---|---|
| `NODE_ENV` | `development`, `test` o `production`. Por defecto `development`. |
| `PORT` | Puerto de la API. Por defecto `3000`. |
| `MONGODB_PORT` | Puerto publicado por Docker Compose. Por defecto `27017`. |
| `MONGODB_USER` | Usuario root de MongoDB. Por defecto `auco`. |
| `MONGODB_PASSWORD` | Contraseña root. Por defecto `auco_dev`. Solo se aplica al crear el volumen. |
| `MONGODB_DB` | Base de datos. Por defecto `auco`. |
| `MONGODB_URI` | Conexión desde el host. Debe usar el mismo usuario, contraseña, puerto y base. |
| `CSC_API_KEY` | Clave de CountryStateCity. Vacía: el enriquecimiento se guarda degradado. |
| `COUNTRIES_API_BASE_URL` | `https://api.countrystatecity.in/v1` |
| `COUNTRIES_API_TIMEOUT_MS` | Tiempo máximo de esa consulta. Por defecto `3000`. |
| `DYNAMODB_PORT` | Puerto publicado por Docker Compose. Por defecto `8000`. |
| `DYNAMODB_ENDPOINT` | `http://localhost:8000`. Debe apuntar a `DYNAMODB_PORT`. |
| `DYNAMODB_REGION` | Región del cliente. Por defecto `us-east-1`. |
| `DYNAMODB_AUDIT_TABLE` | Tabla de auditoría. Por defecto `audit_events`. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Credenciales falsas (`local` / `local`). DynamoDB Local acepta cualquier valor. No las uses en AWS. |

## Instalar y ejecutar

```bash
npm install
npm run dev
```

`npm run dev` arranca la API con recarga y crea la tabla `audit_events` si no existe. La clave de auditoría es `PK = DOCUMENT#<numero>` y `SK = DATE#<fecha>`.

Para producción local, sin recarga:

```bash
npm run build
npm start
```

El script `npm run db:init:audit` crea la misma tabla sin levantar la API.

## Tests

```bash
npm test
```

Eso corre Vitest con Supertest (`npm run test:http`) y después las pruebas de Node. No hace falta Docker: la API externa, MongoDB y DynamoDB van mockeados.

## Endpoints

`POST /validations` recibe JSON:

```json
{
  "name": "Ana Pérez",
  "documentNumber": "1234567890",
  "country": "colombia"
}
```

- `name`: 2 a 120 caracteres. Letras, espacios, apóstrofos o guiones.
- `documentNumber`: 5 a 20 letras o dígitos.
- `country`: opcional. Nombre del país, o su código ISO de dos letras. Si no viene, se usa `Colombia`.

Un cuerpo con solo `name` y `documentNumber` es válido:

```json
{
  "name": "Ana Pérez",
  "documentNumber": "1234567890"
}
```

Respuestas habituales:

- `201`: validación creada. Si CountryStateCity responde, `enrichment.status` es `complete`. Si no hay clave, hay timeout o la API falla, es `degraded` y el registro igual se guarda.
- `400`: body inválido, o el `:id` del GET no es un ObjectId de 24 caracteres hexadecimales.
- `404`: el ObjectId es válido y no hay validación.
- `409`: ya existe una auditoría para ese documento en el mismo instante. El alta se revierte.
- `422`: el país no existe o hay más de una coincidencia. No se guarda nada.
- `503`: DynamoDB no pudo guardar la auditoría y el alta de MongoDB se revirtió. Si el borrado también falla, el código es `INCONSISTENT_WRITE`.

### Crear una validación

```bash
curl -s -X POST http://localhost:3000/validations \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Ana Pérez\",\"documentNumber\":\"1234567890\",\"country\":\"colombia\"}"
```

### Consultarla

Sustituye `ID` por el `id` de 24 caracteres hexadecimales que devolvió el POST.

```bash
curl -s http://localhost:3000/validations/ID
```

Un id con formato válido que no existe:

```bash
curl -s http://localhost:3000/validations/507f1f77bcf86cd799439011
```
# nodetest
