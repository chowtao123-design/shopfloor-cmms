'use strict';

/**
 * OpenAPI 3.1 description of the agent-facing API (Bearer tokens only).
 * Served at GET /openapi.json so a remote agent can discover the real
 * surface without reading this repo.
 *
 * Reads use the incremental feed (`GET /api/changes`); there is no
 * per-record GET, because the client mirror is the source of truth.
 */

const storeEnum = ['machines', 'workOrders', 'pmTasks'];

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
            '`version` to update; a stale version returns 409 with the server copy.',
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
