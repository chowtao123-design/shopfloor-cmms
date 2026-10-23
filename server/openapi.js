'use strict';

/**
 * OpenAPI 3.1 description of the agent-facing API (Bearer tokens only).
 * Served at GET /openapi.json so a remote agent can discover the real
 * surface without reading this repo.
 *
 * Reads use the incremental feed (`GET /api/changes`); there is no
 * per-record GET, because the client mirror is the source of truth.
 */

const storeEnum = ['machines', 'workOrders', 'pmTasks', 'purchaseRequests', 'libraryItems', 'floorMaps', 'floorStations'];

function recordRef() {
  return { $ref: '#/components/schemas/Record' };
}

export function openApiSpec(version = '2.0.0') {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Shopfloor CMMS agent API',
      version,
      description:
        'Machine-to-machine API for the Shopfloor CMMS. Send `Authorization: Bearer <token>` on every request ' +
        '(no cookies, no CSRF header). Tokens are scoped: `read` allows GET only; `write` also allows record ' +
        'create/update/delete. Every write is attributed to the token\'s agent user in the record history. ' +
        'Write bodies are `{data: {...}}`; include the current `version` to get optimistic-concurrency checks.',
    },
    servers: [{ url: '/' }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque token (mlt_…)' },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error', 'message'],
          description: 'Every error response has this flat shape; extra fields may be present (e.g. the server record on 409).',
          properties: {
            error: { type: 'string', description: 'Machine-readable code, e.g. forbidden, not_found, version_conflict.' },
            message: { type: 'string', description: 'Human-readable explanation.' },
          },
        },
        Record: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string' },
            store: { type: 'string', enum: storeEnum },
            seq: { type: 'integer', description: 'Monotonic feed cursor.' },
            version: { type: 'integer' },
            deleted: { type: 'boolean', description: 'Tombstone: the record was deleted.' },
          },
        },
        PurchaseRequestLine: {
          type: 'object',
          description: 'One line of a parts request. Unknown fields are rejected.',
          properties: {
            id: { type: 'string', maxLength: 40 },
            description: { type: 'string', minLength: 1, maxLength: 200 },
            qty: { type: 'number', description: 'Greater than 0, at most 100000, up to two decimals.' },
            unit: { type: 'string', maxLength: 20, default: 'pcs' },
            unitPrice: {
              type: ['number', 'null'],
              minimum: 0,
              maximum: 1000000,
              description: 'Unit price in dollars, up to two decimals; null means "price unknown" (counts as 0 in the totals).',
            },
            partId: { type: 'string' },
            partNumber: { type: 'string', maxLength: 60 },
            supplier: { type: 'string', maxLength: 120 },
            machineId: { type: 'string' },
            workOrderId: { type: 'string' },
            link: { type: 'string', maxLength: 500, description: 'http or https URL.' },
            note: { type: 'string', maxLength: 200 },
          },
          required: ['description'],
        },
        PurchaseRequest: {
          type: 'object',
          description:
            'A parts request (SPEC-v4.md section 2). `number` is assigned by the server on the first save ' +
            '(shown as PR-261022-1: the day it was made, then that day\'s count); totals are calculated from the lines, never stored. Unknown fields are rejected.',
          properties: {
            number: { type: 'integer', description: 'Server-assigned: yymmdd × 1000 + the day\'s count, e.g. 261022001 = PR-261022-1 (older requests: plain 1, 2…); ignored in request bodies.' },
            title: { type: 'string', minLength: 1, maxLength: 120 },
            status: { type: 'string', enum: ['draft', 'sent', 'received', 'cancelled'], default: 'draft' },
            supplier: { type: 'string', maxLength: 120, description: 'Default supplier for the whole request (optional).' },
            neededBy: { type: ['string', 'null'], format: 'date', description: 'ISO date (YYYY-MM-DD) or null.' },
            requestedBy: { type: 'string', maxLength: 80 },
            hstRate: { type: 'number', minimum: 0, maximum: 30, default: 13, description: 'HST percent, up to two decimals.' },
            notes: { type: 'string', maxLength: 2000 },
            sentAt: { type: ['string', 'null'], format: 'date-time', description: 'Set by the client when the status becomes sent.' },
            receivedAt: { type: ['string', 'null'], format: 'date-time', description: 'Set by the client when the status becomes received.' },
            lines: {
              type: 'array',
              maxItems: 100,
              items: { $ref: '#/components/schemas/PurchaseRequestLine' },
            },
          },
          required: ['title'],
        },
        LibraryItem: {
          type: 'object',
          description:
            'A repair-library item (SPEC-v4.md section 4.1): a manual (PDF attachments) or a ' +
            'repair method (symptom -> cause -> steps). Method-only fields are rejected for ' +
            'kind "manual"; unknown fields are rejected.',
          properties: {
            kind: { type: 'string', enum: ['manual', 'method'] },
            title: { type: 'string', minLength: 1, maxLength: 160 },
            machineType: {
              type: ['string', 'null'],
              description: 'Machine type the item applies to when no models/machines are given, or null.',
            },
            models: {
              type: 'array',
              maxItems: 20,
              items: { type: 'string', maxLength: 60 },
              description: 'Model numbers, matched ignoring case, spaces and dashes.',
            },
            machineIds: { type: 'array', maxItems: 50, items: { type: 'string' } },
            tags: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 40 } },
            attachments: {
              type: 'array',
              maxItems: 20,
              items: { type: 'object', description: '{fileId, name, mime, size} upload reference.' },
            },
            notes: { type: 'string', maxLength: 20000, description: 'Text for the AI: key pages/specs typed or pasted.' },
            symptom: { type: 'string', maxLength: 1000, description: 'Method only.' },
            cause: { type: 'string', maxLength: 2000, description: 'Method only.' },
            steps: {
              type: 'array',
              maxItems: 60,
              description: 'Method only.',
              items: {
                type: 'object',
                properties: { id: { type: 'string' }, text: { type: 'string', minLength: 1, maxLength: 1000 } },
                required: ['id', 'text'],
              },
            },
            toolsParts: { type: 'string', maxLength: 1000, description: 'Method only.' },
            safety: { type: 'string', maxLength: 1000, description: 'Method only (lockout points).' },
            sourceWorkOrderId: { type: ['string', 'null'], description: 'Method created from a service order.' },
          },
          required: ['kind', 'title'],
        },
        FloorMapRect: {
          type: 'object',
          description: 'A plain map rectangle. Every map number is finite, -10000...20000, at most two decimals.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            w: { type: 'number' },
            h: { type: 'number' },
          },
          required: ['x', 'y', 'w', 'h'],
        },
        FloorMapBox: {
          type: 'object',
          description:
            'One map box (SPEC-v5.md section 1.1): holds `slots` stations stacked top to bottom in equal ' +
            'parts. Unknown fields are rejected.',
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 40 },
            x: { type: 'number' },
            y: { type: 'number' },
            w: { type: 'number', minimum: 2, description: 'At least 2.' },
            h: { type: 'number', minimum: 2, description: 'At least 2.' },
            slots: {
              type: 'integer',
              minimum: 1,
              maximum: 12,
              default: 1,
              description: 'How many stations stack in the box.',
            },
            fill: { type: ['string', 'null'], description: '#rrggbb or null.' },
            label: { type: 'string', maxLength: 60, default: '' },
            fontSize: {
              type: ['number', 'null'],
              minimum: 1.5,
              maximum: 20,
              description: 'Text size for every slot in the box (drawing units), or null for Auto.',
            },
          },
          required: ['id', 'x', 'y', 'w', 'h'],
        },
        FloorMapFill: {
          type: 'object',
          description: 'A grey/yellow floor patch; `color` is #rrggbb.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            w: { type: 'number' },
            h: { type: 'number' },
            color: { type: 'string', description: '#rrggbb.' },
          },
          required: ['x', 'y', 'w', 'h', 'color'],
        },
        FloorMap: {
          type: 'object',
          description:
            'A floor map (SPEC-v5.md section 1.1): one record per floor, usually one, in drawing units ' +
            '(the import uses PDF points). A record is ~80 KB. Unknown fields are rejected.',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            width: { type: 'number', minimum: 10, maximum: 10000 },
            height: { type: 'number', minimum: 10, maximum: 10000 },
            boxes: { type: 'array', maxItems: 1500, items: { $ref: '#/components/schemas/FloorMapBox' } },
            corridors: { type: 'array', maxItems: 800, items: { $ref: '#/components/schemas/FloorMapRect' } },
            fills: { type: 'array', maxItems: 200, items: { $ref: '#/components/schemas/FloorMapFill' } },
          },
          required: ['name', 'width', 'height'],
        },
        FloorStation: {
          type: 'object',
          description:
            'One station of the floor roster (SPEC-v5.md section 1.2). `boxId` null means off-map (its box ' +
            'was deleted); the station is still listed and flagged. Unknown fields are rejected.',
          properties: {
            mapId: { type: 'string', description: 'The floorMaps record this station belongs to.' },
            boxId: { type: ['string', 'null'], description: 'The box holding the station, or null when off-map.' },
            slot: { type: 'integer', minimum: 0, maximum: 11, default: 0, description: 'Position inside the box.' },
            code: { type: 'string', maxLength: 40, description: 'Station label printed on the map, e.g. "SP14".' },
            zone: { type: 'string', maxLength: 60 },
            name: { type: 'string', maxLength: 80, description: 'Staff name (English).' },
            nameCn: { type: 'string', maxLength: 80, description: 'Staff name (Chinese).' },
            empId: { type: 'string', maxLength: 20, description: 'Employee ID.' },
            vacant: { type: 'boolean', default: false },
            remark: { type: 'string', maxLength: 200 },
            machineId: { type: ['string', 'null'], description: 'The linked CMMS machine, or null.' },
          },
          required: ['mapId'],
        },
        HistoryEntry: {
          type: 'object',
          additionalProperties: true,
          properties: {
            hid: { type: 'integer' },
            version: { type: 'integer' },
            action: { type: 'string' },
            at: { type: 'string', format: 'date-time' },
            userId: { type: 'string' },
            displayName: { type: ['string', 'null'] },
            note: { type: ['string', 'null'] },
          },
        },
        WriteResult: {
          type: 'object',
          properties: {
            record: recordRef(),
            history: { $ref: '#/components/schemas/HistoryEntry' },
          },
        },
      },
      parameters: {
        Store: { name: 'store', in: 'path', required: true, schema: { type: 'string', enum: storeEnum } },
        Id: { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        Since: {
          name: 'since',
          in: 'query',
          required: false,
          description: 'Return records with seq > since. Start at 0 for the first sync.',
          schema: { type: 'integer', minimum: 0, default: 0 },
        },
        Limit: {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 1000, default: 500 },
        },
      },
      responses: {
        Unauthorized: {
          description: 'Missing, invalid or revoked token',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        Forbidden: {
          description: 'Token scope or role permissions do not allow this action',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        BadRequest: {
          description: 'Invalid body or field value',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        NotFound: {
          description: 'No such route or record',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    },
    paths: {
      '/health': {
        get: {
          operationId: 'health',
          summary: 'Liveness probe (no auth)',
          security: [],
          responses: {
            200: {
              description: 'Server is up',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { ok: { type: 'boolean' }, version: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      '/api/me': {
        get: {
          operationId: 'me',
          summary: 'The agent identity behind this token',
          responses: {
            200: { description: 'User, role and permissions' },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/api/changes': {
        get: {
          operationId: 'changesFeed',
          summary: 'Incremental record feed (the only read endpoint)',
          description:
            'Returns records whose seq is greater than `since`, oldest first, including `deleted` tombstones. ' +
            'Page with `more`, then call again with `since=lastSeq`. Stores the token\'s role cannot read are omitted.',
          parameters: [
            { $ref: '#/components/parameters/Since' },
            { $ref: '#/components/parameters/Limit' },
          ],
          responses: {
            200: {
              description: 'One page of the feed',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['records', 'lastSeq', 'more'],
                    properties: {
                      records: { type: 'array', items: recordRef() },
                      lastSeq: { type: 'integer' },
                      more: { type: 'boolean' },
                    },
                  },
                },
              },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/api/records/{store}/{id}': {
        parameters: [
          { $ref: '#/components/parameters/Store' },
          { $ref: '#/components/parameters/Id' },
        ],
        put: {
          operationId: 'putRecord',
          summary: 'Create or update one record (write scope)',
          description:
            'Send `{data: {...}}`. Omit `version` to create with a client-generated id, or send the current ' +
            '`version` to update; a stale version returns 409 with the server copy. `store` may also be ' +
            '`purchaseRequests` (parts requests, the `PurchaseRequest` schema): `number` there is assigned by ' +
            'the server and ignored in the body, and a PUT replaces the whole record — read the current one ' +
            'from `GET /api/changes` first, then send it back with the new lines. `store` may likewise be ' +
            '`libraryItems` (the repair library, the `LibraryItem` schema); method-only fields are rejected ' +
            'for manuals, and a PUT replaces the whole record the same way. `store` may also be `floorMaps` ' +
            'or `floorStations` (the floor map, the `FloorMap`/`FloorStation` schemas, SPEC-v5.md section 1): ' +
            'geometry numbers are finite -10000...20000 with at most two decimals and unknown fields are ' +
            'rejected; agents rarely touch them (the roster is imported by the admin CLI), and the stores ' +
            'never appear in AI answers.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['data'],
                  properties: { data: { type: 'object', additionalProperties: true } },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Saved record plus the history row',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/WriteResult' } } },
            },
            400: { $ref: '#/components/responses/BadRequest' },
            401: { $ref: '#/components/responses/Unauthorized' },
            403: { $ref: '#/components/responses/Forbidden' },
            409: { description: 'Version conflict; body carries the server copy' },
          },
        },
        delete: {
          operationId: 'deleteRecord',
          summary: 'Delete one record (write scope, tombstone)',
          parameters: [
            {
              name: 'baseVersion',
              in: 'query',
              required: false,
              schema: { type: 'integer' },
            },
          ],
          responses: {
            200: { description: 'Deleted (tombstone), with history row' },
            401: { $ref: '#/components/responses/Unauthorized' },
            403: { $ref: '#/components/responses/Forbidden' },
            404: { $ref: '#/components/responses/NotFound' },
            409: { description: 'Version conflict' },
          },
        },
      },
      '/api/history/{store}/{id}': {
        parameters: [
          { $ref: '#/components/parameters/Store' },
          { $ref: '#/components/parameters/Id' },
        ],
        get: {
          operationId: 'recordHistory',
          summary: 'Full audit history of one record',
          responses: {
            200: {
              description: 'History entries, newest first',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { $ref: '#/components/schemas/HistoryEntry' } },
                },
              },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
            404: { $ref: '#/components/responses/NotFound' },
          },
        },
      },
    },
  };
}
