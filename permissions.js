const LEVELS = ['none', 'read', 'write'];

const LEVEL_RANK = new Map(LEVELS.map((level, index) => [level, index]));

const AREAS = [
  { key: 'serviceOrders', label: 'Service Orders' },
  { key: 'pm', label: 'Preventive Maintenance' },
  { key: 'machines', label: 'Machines' },
  // v5 (SPEC-v5.md section 1.3): the floor map and its stations.
  { key: 'floorMap', label: 'Floor map & stations' },
  { key: 'parts', label: 'Parts & Stock' },
  // v4 (SPEC-v4.md section 1): parts requests and the repair library.
  { key: 'purchasing', label: 'Parts requests' },
  { key: 'library', label: 'Library (manuals & repair methods)' },
  { key: 'coworkers', label: 'Coworkers' },
  { key: 'contractors', label: 'Outside Contractors' },
  { key: 'contractorRates', label: 'Contractor rates & costs' },
  { key: 'statistics', label: 'Statistics' },
  { key: 'files', label: 'Photos & files' },
  { key: 'backups', label: 'Backups' },
  { key: 'aiAssistant', label: 'AI assistant' },
  { key: 'settings', label: 'Branding & AI settings' },
  { key: 'admin', label: 'Users & roles' },
];

const AREA_KEYS = AREAS.map((area) => area.key);

const AREA_BY_KEY = new Map(AREAS.map((area) => [area.key, area]));

const STORE_AREAS = new Map([
  ['workOrders', 'serviceOrders'],
  ['pmTasks', 'pm'],
  ['machines', 'machines'],
  // v5 (SPEC-v5.md section 1.3): both floor stores -> the floorMap area.
  ['floorMaps', 'floorMap'],
  ['floorStations', 'floorMap'],
  ['parts', 'parts'],
  // v4 (SPEC-v4.md section 1): purchaseRequests -> purchasing,
  // libraryItems -> library.
  ['purchaseRequests', 'purchasing'],
  ['libraryItems', 'library'],
  ['coworkers', 'coworkers'],
  ['contractors', 'contractors'],
]);

function areaLabel(key) {
  const found = key && typeof key === 'string' ? AREA_BY_KEY.get(key) : undefined;
  if (found) return found.label;
  const storeAreaKey = typeof key === 'string' ? STORE_AREAS.get(key) : undefined;
  if (storeAreaKey) return AREA_BY_KEY.get(storeAreaKey).label;
  return typeof key === 'string' && key ? key : 'this area';
}

function storeArea(storeName) {
  const area = typeof storeName === 'string' ? STORE_AREAS.get(storeName) : undefined;
  return area === undefined ? null : area;
}

function allNonePermissions() {
  const permissions = {};
  for (const key of AREA_KEYS) permissions[key] = 'none';
  return permissions;
}

function normalizeLevel(value) {
  return LEVEL_RANK.has(value) ? value : 'none';
}

function allows(permissions, area, level = 'read') {
  if (!AREA_BY_KEY.has(area)) {
    throw new Error(`allows(): unknown permission area "${area}"`);
  }
  if (!LEVEL_RANK.has(level)) {
    throw new Error(`allows(): unknown permission level "${level}"`);
  }
  if (permissions === null || permissions === undefined || typeof permissions !== 'object') {
    return false;
  }
  const granted = normalizeLevel(permissions[area]);
  return LEVEL_RANK.get(granted) >= LEVEL_RANK.get(level);
}

function isReadOnlyLevel(permissions, area) {
  return allows(permissions, area, 'read') && !allows(permissions, area, 'write');
}

export {
  LEVELS,
  LEVEL_RANK,
  AREAS,
  AREA_KEYS,
  areaLabel,
  storeArea,
  allNonePermissions,
  normalizeLevel,
  allows,
  isReadOnlyLevel,
};