export interface PaginationConfig {
  kind: 'query' | 'path' | 'postback' | 'click' | 'api';
  param?: string;
  pathPattern?: string;
  maxPages: number;
  quickMaxPages?: number;
  deepMaxPages?: number;
  nextSelector?: string;
}

export interface PortalDefinition {
  id: string;
  name: string;
  category: 'Regulatory' | 'Federal/Regional' | 'Tech & Skills' | 'Multilateral' | 'Aggregator';
  tier: 'playwright' | 'http';
  baseUrl: string;
  tendersUrl: string;
  fileCode?: string;
  loginUrl?: string;
  description: string;
  defaultKeywords: string[];
  accessMode: 'public' | 'login_required' | 'cloudflare' | 'offline_broken';
  verifiedStatus: string;
  pagination?: PaginationConfig;
}

export const PORTAL_DEFINITIONS: PortalDefinition[] = [
  // 1. Regulatory Authorities (PPRAs)
  {
    id: 'epms_ppra',
    name: 'Federal PPRA (EPMS)',
    category: 'Regulatory',
    tier: 'http',
    baseUrl: 'https://epms.ppra.gov.pk',
    tendersUrl: 'https://epms.ppra.gov.pk/public/tenders/active-tenders',
    fileCode: 'FPPRA',
    description: 'Federal Public Procurement Regulatory Authority open tender board (50/page + public PDFs & bid security)',
    defaultKeywords: ['construction', 'solar', 'stationery', 'education', 'tvet'],
    accessMode: 'public',
    verifiedStatus: 'Verified open Federal EPMS SSR tender board (50/page + public PDFs)',
    pagination: { kind: 'query', param: 'page', maxPages: 3, quickMaxPages: 2, deepMaxPages: 5 }
  },
  {
    id: 'punjab_eproc',
    name: 'Punjab PPRA (eproc.punjab.gov.pk)',
    category: 'Regulatory',
    tier: 'http',
    baseUrl: 'https://eproc.punjab.gov.pk',
    tendersUrl: 'https://eproc.punjab.gov.pk/ActiveTenders.aspx',
    fileCode: 'PPPRA',
    description: 'Punjab provincial e-Procurement portal (865+ live tenders, no login needed)',
    defaultKeywords: ['renovation', 'photovoltaic', 'stationery', 'consultancy', 'civil works'],
    accessMode: 'public',
    verifiedStatus: 'Working — Top provincial source',
    pagination: { kind: 'postback', maxPages: 3, quickMaxPages: 3, deepMaxPages: 10 }
  },
  {
    id: 'sppra',
    name: 'Sindh SPPRA (portalsindh.eprocure.gov.pk)',
    category: 'Regulatory',
    tier: 'http',
    baseUrl: 'https://portalsindh.eprocure.gov.pk',
    tendersUrl: 'https://portalsindh.eprocure.gov.pk/#/',
    fileCode: 'SPPRA',
    description: 'Sindh Public Procurement Regulatory Authority EPADS public portal (13,500+ live tenders via public JSON API & DMS PDFs)',
    defaultKeywords: ['masonry', 'solarization', 'curriculum', 'toner', 'infrastructure'],
    accessMode: 'public',
    verifiedStatus: 'Working — Live SPPRA EPADS public JSON API & DMS PDF downloads',
    pagination: { kind: 'api', maxPages: 3, quickMaxPages: 2, deepMaxPages: 6 }
  },
  {
    id: 'kppra',
    name: 'Khyber Pakhtunkhwa KPPRA (kp.eprocure.gov.pk)',
    category: 'Regulatory',
    tier: 'playwright',
    baseUrl: 'https://kp.eprocure.gov.pk',
    tendersUrl: 'https://kp.eprocure.gov.pk',
    fileCode: 'KPPRA',
    description: 'KP EPADS portal (Protected by basic-auth challenge, marketing domain unreachable)',
    defaultKeywords: ['civil works', 'solarization', 'textbooks', 'equipment'],
    accessMode: 'offline_broken',
    verifiedStatus: 'Access-walled / basic-auth challenge on portal'
  },
  {
    id: 'bppra',
    name: 'Balochistan BPPRA',
    category: 'Regulatory',
    tier: 'playwright',
    baseUrl: 'https://bpptwo.vdc.services:5451',
    tendersUrl: 'https://bpptwo.vdc.services:5451/Tenders',
    fileCode: 'BPPRA',
    description: 'Balochistan Public Procurement Regulatory Authority ePPS portal (400+ active tenders across Tenders, RFP, Pre-Qualification & EOI + NIT/BOQ API)',
    defaultKeywords: ['infrastructure', 'solar', 'office supplies', 'training'],
    accessMode: 'public',
    verifiedStatus: 'Working — Live BPPRA Blazor active tenders (100/page) & :9446 NIT/BOQ API',
    pagination: { kind: 'click', maxPages: 3, quickMaxPages: 2, deepMaxPages: 5 }
  },

  // 2. Federal & Regional Government Entities
  {
    id: 'ndma',
    name: 'National Disaster Management Authority (NDMA)',
    category: 'Federal/Regional',
    tier: 'http',
    baseUrl: 'https://ndma.gov.pk',
    tendersUrl: 'https://ndma.gov.pk/tenders',
    fileCode: 'NDMA',
    description: 'Federal disaster management emergency procurement (34 pages of listings)',
    defaultKeywords: ['rehabilitation', 'solar', 'supplies', 'prefabricated', 'tents'],
    accessMode: 'public',
    verifiedStatus: 'Working — 34 pages of tenders',
    pagination: { kind: 'query', param: 'page', maxPages: 3, quickMaxPages: 2, deepMaxPages: 5 }
  },
  {
    id: 'fde',
    name: 'Federal Directorate of Education (FDE)',
    category: 'Federal/Regional',
    tier: 'http',
    baseUrl: 'https://fde.gov.pk',
    tendersUrl: 'https://fde.gov.pk/download-category/tender/',
    fileCode: 'FDE',
    description: 'Islamabad Capital Territory educational procurement & school solarization',
    defaultKeywords: ['textbooks', 'school supplies', 'solarization', 'furniture'],
    accessMode: 'public',
    verifiedStatus: 'Working — Corrected URL'
  },
  {
    id: 'mofept',
    name: 'Ministry of Federal Education & Professional Training',
    category: 'Federal/Regional',
    tier: 'http',
    baseUrl: 'https://mofept.gov.pk',
    tendersUrl: 'https://mofept.gov.pk/Tenders',
    fileCode: 'MOFEPT',
    description: 'Federal education ministry active tenders with built-in search box',
    defaultKeywords: ['curriculum', 'technical training', 'capacity building', 'it consumables'],
    accessMode: 'public',
    verifiedStatus: 'Working — 18 active tenders'
  },
  {
    id: 'gilgit',
    name: 'Government of Gilgit-Baltistan',
    category: 'Federal/Regional',
    tier: 'http',
    baseUrl: 'https://gilgitbaltistan.gov.pk',
    tendersUrl: 'https://gilgitbaltistan.gov.pk',
    fileCode: 'GB',
    description: 'Gilgit-Baltistan portal (no dedicated public tenders board)',
    defaultKeywords: ['civil works', 'solar', 'education', 'printing'],
    accessMode: 'offline_broken',
    verifiedStatus: 'Partial — No dedicated tenders section; /Tenders 404s'
  },

  // 3. Technology, Skills & Education Authorities
  {
    id: 'pseb',
    name: 'Pakistan Software Export Board (TechDestination)',
    category: 'Tech & Skills',
    tier: 'http',
    baseUrl: 'https://techdestination.com',
    tendersUrl: 'https://techdestination.com/tenders/',
    fileCode: 'PSEB',
    description: 'Rebranded from pseb.org.pk to techdestination.com/tenders/',
    defaultKeywords: ['it consumables', 'training', 'video production', 'office supplies'],
    accessMode: 'public',
    verifiedStatus: 'Working — Rebranded to TechDestination'
  },
  {
    id: 'ignite',
    name: 'Ignite National Technology Fund',
    category: 'Tech & Skills',
    tier: 'http',
    baseUrl: 'https://ignite.org.pk',
    tendersUrl: 'https://ignite.org.pk/procurement/',
    fileCode: 'IGNITE',
    description: 'National innovation fund procurement, RFPs & incubators',
    defaultKeywords: ['rfp', 'media production', 'consultancy', 'skill development'],
    accessMode: 'public',
    verifiedStatus: 'Working — Corrected URL (Tender Notice tab)'
  },
  {
    id: 'psdf',
    name: 'Punjab Skills Development Fund (PSDF)',
    category: 'Tech & Skills',
    tier: 'http',
    baseUrl: 'https://psdf.org.pk',
    tendersUrl: 'https://psdf.org.pk/procurement',
    fileCode: 'PSDF',
    description: 'Apex skills development fund active procurements & TVET schemes',
    defaultKeywords: ['tvet', 'vocational', 'technical training', 'employability'],
    accessMode: 'public',
    verifiedStatus: 'Working — Active procurements'
  },
  {
    id: 'psda',
    name: 'Punjab Skills Development Authority (PSDA)',
    category: 'Tech & Skills',
    tier: 'http',
    baseUrl: 'https://psda.punjab.gov.pk',
    tendersUrl: 'https://psda.punjab.gov.pk/tenders',
    fileCode: 'PSDA',
    description: 'Provincial regulatory authority for vocational and technical institutions',
    defaultKeywords: ['capacity building', 'vocational courses', 'training'],
    accessMode: 'public',
    verifiedStatus: 'Working — Currently 0 open tenders'
  },
  {
    id: 'peef',
    name: 'Punjab Educational Endowment Fund (PEEF)',
    category: 'Tech & Skills',
    tier: 'http',
    baseUrl: 'https://peef.org.pk',
    tendersUrl: 'https://peef.org.pk/tenders',
    fileCode: 'PEEF',
    description: 'Educational endowment quotations, IT consumables & stationery',
    defaultKeywords: ['printing', 'paper', 'stationery', 'toner'],
    accessMode: 'public',
    verifiedStatus: 'Working — Handled via SSL-tolerant agent'
  },

  // 4. International & Multilateral Agencies
  {
    id: 'ungm',
    name: 'United Nations Global Marketplace (UNGM)',
    category: 'Multilateral',
    tier: 'playwright',
    baseUrl: 'https://www.ungm.org',
    tendersUrl: 'https://www.ungm.org/Public/Notice',
    fileCode: 'UNGM',
    description: 'UN agencies global procurement with rich filters (1,700+ live notices)',
    defaultKeywords: ['education', 'clean energy', 'rehabilitation', 'advocacy campaign'],
    accessMode: 'public',
    verifiedStatus: 'Working — 1,700+ live notices',
    pagination: { kind: 'query', param: 'page', maxPages: 3, quickMaxPages: 2, deepMaxPages: 5 }
  },
  {
    id: 'giz',
    name: 'Deutsche Gesellschaft für Internationale Zusammenarbeit (GIZ)',
    category: 'Multilateral',
    tier: 'http',
    baseUrl: 'https://www.giz.de',
    tendersUrl: 'https://www.giz.de/en/workingwithgiz/bidding_procurement.html',
    fileCode: 'GIZ',
    description: 'German development agency country procurement (Corrected URL)',
    defaultKeywords: ['tvet', 'renewable energy', 'technical training', 'capacity building'],
    accessMode: 'public',
    verifiedStatus: 'Working — Global bidding procurement page'
  },

  // 5. Aggregators & Classified Sources
  {
    id: 'tender_services',
    name: 'Tender Services Pakistan',
    category: 'Aggregator',
    tier: 'playwright',
    baseUrl: 'https://tenderservice.pk',
    tendersUrl: 'https://tenderservice.pk',
    loginUrl: 'https://tenderservice.pk/permits/login.php',
    fileCode: 'TSP',
    description: 'Commercial aggregator consolidating nationwide public notices',
    defaultKeywords: ['construction', 'solar', 'education', 'stationery', 'video production'],
    accessMode: 'login_required',
    verifiedStatus: 'Login required (permits/login.php)'
  },
  {
    id: 'pid',
    name: 'Press Information Department / Gazettes (PID)',
    category: 'Aggregator',
    tier: 'http',
    baseUrl: 'https://pid.gov.pk',
    tendersUrl: 'https://pid.gov.pk',
    fileCode: 'PID',
    description: 'Government statutory gazettes & Press Information Department (PID)',
    defaultKeywords: ['gazette', 'tender notice', 'corrigendum', 'extension'],
    accessMode: 'public',
    verifiedStatus: 'Working — Government gazette releases'
  }
];
