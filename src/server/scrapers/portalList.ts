export interface PortalDefinition {
  id: string;
  name: string;
  category: 'Regulatory' | 'Federal/Regional' | 'Tech & Skills' | 'Multilateral' | 'Aggregator';
  tier: 'playwright' | 'http';
  baseUrl: string;
  tendersUrl: string;
  loginUrl?: string;
  description: string;
  defaultKeywords: string[];
  accessMode: 'public' | 'login_required' | 'cloudflare' | 'offline_broken';
  verifiedStatus: string;
}

export const PORTAL_DEFINITIONS: PortalDefinition[] = [
  // 1. Regulatory Authorities (PPRAs)
  {
    id: 'epads',
    name: 'Federal PPRA (EPMS / EPADS)',
    category: 'Regulatory',
    tier: 'playwright',
    baseUrl: 'https://www.ppra.gov.pk',
    tendersUrl: 'https://epms.ppra.gov.pk/',
    loginUrl: 'https://epms.ppra.gov.pk/',
    description: 'Federal statutory public procurement electronic system (EPMS/EPADS)',
    defaultKeywords: ['construction', 'solar', 'stationery', 'education', 'tvet'],
    accessMode: 'login_required',
    verifiedStatus: 'Main site public; EPMS portal requires operator credentials'
  },
  {
    id: 'punjab_eproc',
    name: 'Punjab PPRA (eproc.punjab.gov.pk)',
    category: 'Regulatory',
    tier: 'http',
    baseUrl: 'https://ppra.punjab.gov.pk',
    tendersUrl: 'http://eproc.punjab.gov.pk/ActiveTenders.aspx',
    description: 'Punjab provincial e-Procurement portal (865+ live tenders, no login needed)',
    defaultKeywords: ['renovation', 'photovoltaic', 'stationery', 'consultancy', 'civil works'],
    accessMode: 'public',
    verifiedStatus: 'Working — Top provincial source'
  },
  {
    id: 'sppra',
    name: 'Sindh SPPRA (portalsindh.eprocure.gov.pk)',
    category: 'Regulatory',
    tier: 'playwright',
    baseUrl: 'https://portalsindh.eprocure.gov.pk',
    tendersUrl: 'https://portalsindh.eprocure.gov.pk',
    description: 'Sindh Public Procurement Authority (12,900+ live tenders with full filters)',
    defaultKeywords: ['masonry', 'solarization', 'curriculum', 'toner', 'infrastructure'],
    accessMode: 'public',
    verifiedStatus: 'Working — Massive repository, public access'
  },
  {
    id: 'kppra',
    name: 'Khyber Pakhtunkhwa KPPRA (kp.eprocure.gov.pk)',
    category: 'Regulatory',
    tier: 'playwright',
    baseUrl: 'https://kp.eprocure.gov.pk',
    tendersUrl: 'https://kp.eprocure.gov.pk',
    description: 'KP EPADS portal (Protected by basic-auth challenge, marketing domain unreachable)',
    defaultKeywords: ['civil works', 'solarization', 'textbooks', 'equipment'],
    accessMode: 'offline_broken',
    verifiedStatus: 'Access-walled / basic-auth challenge on portal'
  },
  {
    id: 'bppra',
    name: 'Balochistan BPPRA',
    category: 'Regulatory',
    tier: 'http',
    baseUrl: 'https://bpptwo.vdc.services:5451',
    tendersUrl: 'https://bpptwo.vdc.services:5451/Tenders',
    description: 'Balochistan Public Procurement Regulatory Authority ePPS portal (80+ active tenders)',
    defaultKeywords: ['infrastructure', 'solar', 'office supplies', 'training'],
    accessMode: 'public',
    verifiedStatus: 'Working — Live BPPRA ePPS portal (bpptwo.vdc.services:5451)'
  },

  // 2. Federal & Regional Government Entities
  {
    id: 'ndma',
    name: 'National Disaster Management Authority (NDMA)',
    category: 'Federal/Regional',
    tier: 'http',
    baseUrl: 'https://ndma.gov.pk',
    tendersUrl: 'https://ndma.gov.pk/tenders',
    description: 'Federal disaster management emergency procurement (34 pages of listings)',
    defaultKeywords: ['rehabilitation', 'solar', 'supplies', 'prefabricated', 'tents'],
    accessMode: 'public',
    verifiedStatus: 'Working — 34 pages of tenders'
  },
  {
    id: 'fde',
    name: 'Federal Directorate of Education (FDE)',
    category: 'Federal/Regional',
    tier: 'http',
    baseUrl: 'https://fde.gov.pk',
    tendersUrl: 'https://fde.gov.pk/download-category/tender/',
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
    description: 'UN agencies global procurement with rich filters (1,700+ live notices)',
    defaultKeywords: ['education', 'clean energy', 'rehabilitation', 'advocacy campaign'],
    accessMode: 'public',
    verifiedStatus: 'Working — 1,700+ live notices'
  },
  {
    id: 'giz',
    name: 'Deutsche Gesellschaft für Internationale Zusammenarbeit (GIZ)',
    category: 'Multilateral',
    tier: 'http',
    baseUrl: 'https://www.giz.de',
    tendersUrl: 'https://www.giz.de/en/workingwithgiz/bidding_procurement.html',
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
    description: 'Government statutory gazettes & Press Information Department (PID)',
    defaultKeywords: ['gazette', 'tender notice', 'corrigendum', 'extension'],
    accessMode: 'public',
    verifiedStatus: 'Working — Government gazette releases'
  }
];
