export interface TrackMatchEvaluationPair {
  id: string;
  tenderTitle: string;
  tenderDescription?: string;
  trackName: string;
  trackKeywords: string[];
  isMatch: boolean;
  domain: string;
}

export const TRACK_MATCH_CALIBRATION_SET: TrackMatchEvaluationPair[] = [
  // --- 25 Positive Matches (synonymous, conceptual, procurement domain overlap) ---
  {
    id: 'pos-solar-1',
    tenderTitle: 'Installation of 500kW rooftop photovoltaic array and net metering at University campus',
    trackName: 'Solar & Clean Energy',
    trackKeywords: ['solar', 'solarization', 'pv system', 'photovoltaic', 'inverter', 'clean energy'],
    isMatch: true,
    domain: 'solar'
  },
  {
    id: 'pos-solar-2',
    tenderTitle: 'Turnkey hybrid solar system with lithium iron phosphate battery storage for rural health center',
    trackName: 'Solar & Clean Energy',
    trackKeywords: ['solar', 'solarization', 'pv system', 'inverter', 'battery bank'],
    isMatch: true,
    domain: 'solar'
  },
  {
    id: 'pos-solar-3',
    tenderTitle: 'Supply of solar-powered tube wells and solar submersible pumps for agricultural irrigation',
    trackName: 'Solar & Clean Energy',
    trackKeywords: ['solar', 'solarization', 'photovoltaic', 'clean energy', 'solar panels'],
    isMatch: true,
    domain: 'solar'
  },
  {
    id: 'pos-solar-4',
    tenderTitle: 'Supply and erection of monocrystalline solar panels with grid-tied inverters',
    trackName: 'Solar & Clean Energy',
    trackKeywords: ['solar', 'photovoltaic', 'clean energy', 'solar panels'],
    isMatch: true,
    domain: 'solar'
  },
  {
    id: 'pos-solar-5',
    tenderTitle: 'Solarization of 200 public schools in South Punjab with net-metering facilities',
    trackName: 'Solar & Clean Energy',
    trackKeywords: ['solar', 'solarization', 'clean energy', 'solar panels'],
    isMatch: true,
    domain: 'solar'
  },
  {
    id: 'pos-civil-1',
    tenderTitle: 'Construction of two-lane asphalt concrete highway from Mastung to Kalat',
    trackName: 'Construction & Civil Works',
    trackKeywords: ['construction', 'civil works', 'infrastructure', 'asphalt', 'earthwork'],
    isMatch: true,
    domain: 'civil'
  },
  {
    id: 'pos-civil-2',
    tenderTitle: 'Rehabilitation and structural retrofitting of District Headquarters Hospital building',
    trackName: 'Construction & Civil Works',
    trackKeywords: ['construction', 'civil works', 'renovation', 'rehabilitation', 'building repair'],
    isMatch: true,
    domain: 'civil'
  },
  {
    id: 'pos-civil-3',
    tenderTitle: 'Earthwork, PCC foundation, and reinforced cement concrete (RCC) culverts',
    trackName: 'Construction & Civil Works',
    trackKeywords: ['construction', 'civil works', 'infrastructure', 'masonry', 'earthwork'],
    isMatch: true,
    domain: 'civil'
  },
  {
    id: 'pos-civil-4',
    tenderTitle: 'Boundary wall with razor wire fencing and guard post for sub-divisional complex',
    trackName: 'Construction & Civil Works',
    trackKeywords: ['construction', 'civil works', 'infrastructure', 'building repair'],
    isMatch: true,
    domain: 'civil'
  },
  {
    id: 'pos-civil-5',
    tenderTitle: 'Refurbishment, floor tiling, distempering, and sanitary fittings of Judicial Complex',
    trackName: 'Construction & Civil Works',
    trackKeywords: ['construction', 'civil works', 'renovation', 'rehabilitation'],
    isMatch: true,
    domain: 'civil'
  },
  {
    id: 'pos-edu-1',
    tenderTitle: 'Printing and distribution of single national curriculum textbooks for grade 1 to 5',
    trackName: 'Education & Learning',
    trackKeywords: ['education', 'curriculum', 'textbooks', 'learning material', 'school supplies'],
    isMatch: true,
    domain: 'education'
  },
  {
    id: 'pos-edu-2',
    tenderTitle: 'Procurement of science laboratory equipment, glassware, and physics models for higher secondary schools',
    trackName: 'Education & Learning',
    trackKeywords: ['education', 'learning material', 'school supplies', 'classroom'],
    isMatch: true,
    domain: 'education'
  },
  {
    id: 'pos-edu-3',
    tenderTitle: 'Digital interactive smart boards and classroom audio-visual learning aids',
    trackName: 'Education & Learning',
    trackKeywords: ['education', 'learning material', 'classroom', 'edtech'],
    isMatch: true,
    domain: 'education'
  },
  {
    id: 'pos-edu-4',
    tenderTitle: 'Teacher pedagogical training and capacity building workshops across divisional headquarter schools',
    trackName: 'Education & Learning',
    trackKeywords: ['education', 'curriculum', 'teacher training', 'classroom'],
    isMatch: true,
    domain: 'education'
  },
  {
    id: 'pos-edu-5',
    tenderTitle: 'Merit-based scholarship disbursement program for deserving college students in underprivileged districts',
    trackName: 'Education & Learning',
    trackKeywords: ['education', 'scholarships', 'learning material'],
    isMatch: true,
    domain: 'education'
  },
  {
    id: 'pos-tvet-1',
    tenderTitle: 'Hiring of training service providers for technical courses in industrial automation and CNC machining',
    trackName: 'Vocational Training (TVET)',
    trackKeywords: ['tvet', 'vocational', 'technical training', 'training service provider'],
    isMatch: true,
    domain: 'tvet'
  },
  {
    id: 'pos-tvet-2',
    tenderTitle: 'Apprenticeship placement and skill enhancement program for unemployed youth',
    trackName: 'Vocational Training (TVET)',
    trackKeywords: ['tvet', 'vocational', 'skill development', 'youth skills', 'apprenticeship'],
    isMatch: true,
    domain: 'tvet'
  },
  {
    id: 'pos-tvet-3',
    tenderTitle: 'Competency-based training in hospitality, culinary arts, and customer service',
    trackName: 'Vocational Training (TVET)',
    trackKeywords: ['tvet', 'vocational', 'technical training', 'vocational courses'],
    isMatch: true,
    domain: 'tvet'
  },
  {
    id: 'pos-tvet-4',
    tenderTitle: 'Provision of vocational toolkits and barber/tailoring start-up packages for course graduates',
    trackName: 'Vocational Training (TVET)',
    trackKeywords: ['tvet', 'vocational', 'skill development', 'tool kits'],
    isMatch: true,
    domain: 'tvet'
  },
  {
    id: 'pos-tvet-5',
    tenderTitle: 'Capacity building and technical certification in domestic electrical wiring and plumbing',
    trackName: 'Vocational Training (TVET)',
    trackKeywords: ['tvet', 'vocational', 'technical training', 'capacity building'],
    isMatch: true,
    domain: 'tvet'
  },
  {
    id: 'pos-stat-1',
    tenderTitle: 'Supply of 80gsm A4 photocopying paper reams, legal paper, and cardboard folders',
    trackName: 'Stationery & Office Supplies',
    trackKeywords: ['stationery', 'paper', 'office supplies', 'printing paper'],
    isMatch: true,
    domain: 'stationery'
  },
  {
    id: 'pos-stat-2',
    tenderTitle: 'Procurement of original high-yield toner cartridges for HP LaserJet enterprise printers',
    trackName: 'Stationery & Office Supplies',
    trackKeywords: ['stationery', 'toner', 'cartridge', 'office supplies'],
    isMatch: true,
    domain: 'stationery'
  },
  {
    id: 'pos-stat-3',
    tenderTitle: 'Annual rate contract for general office stationery, ballpoints, staplers, and registers',
    trackName: 'Stationery & Office Supplies',
    trackKeywords: ['stationery', 'office supplies', 'paper', 'office consumables'],
    isMatch: true,
    domain: 'stationery'
  },
  {
    id: 'pos-it-1',
    tenderTitle: 'Procurement of rack-mount blade servers, SAN storage array, and LTO tape library',
    trackName: 'IT Consumables & Equipment',
    trackKeywords: ['it consumables', 'server', 'computing', 'datacenter', 'hardware'],
    isMatch: true,
    domain: 'it'
  },
  {
    id: 'pos-it-2',
    tenderTitle: 'Supply of 350 enterprise business laptops with Intel Core i7 processors and docking stations',
    trackName: 'IT Consumables & Equipment',
    trackKeywords: ['it consumables', 'laptop', 'computer', 'hardware'],
    isMatch: true,
    domain: 'it'
  },

  // --- 25 Negative Matches (cross-domain, orthogonal, boundary cases) ---
  {
    id: 'neg-med-1',
    tenderTitle: 'Procurement of medicines, antibiotics, and surgical sutures for DHQ Hospital',
    trackName: 'Construction & Civil Works',
    trackKeywords: ['construction', 'civil works', 'infrastructure', 'masonry'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-food-1',
    tenderTitle: 'Supply of high-protein dietary supplements and infant formula for nutrition centers',
    trackName: 'Solar & Clean Energy',
    trackKeywords: ['solar', 'solarization', 'clean energy', 'solar panels'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-jani-1',
    tenderTitle: 'Annual janitorial, housekeeping, and pest control services for Secretariat offices',
    trackName: 'Education & Learning',
    trackKeywords: ['education', 'curriculum', 'textbooks', 'classroom'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-veh-1',
    tenderTitle: 'Rental of luxury 4x4 double-cabin vehicles and passenger vans with drivers',
    trackName: 'Vocational Training (TVET)',
    trackKeywords: ['tvet', 'vocational', 'skill development', 'technical training'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-sec-1',
    tenderTitle: 'Security guard services with licensed automatic weapons for commercial bank branches',
    trackName: 'Stationery & Office Supplies',
    trackKeywords: ['stationery', 'paper', 'office supplies', 'toner'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-cat-1',
    tenderTitle: 'Catering and provision of buffet lunch and tea breaks for conference delegates',
    trackName: 'IT Consumables & Equipment',
    trackKeywords: ['it consumables', 'laptop', 'server', 'computer'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-uni-1',
    tenderTitle: 'Supply of uniform shoes, combat boots, and berets for police personnel',
    trackName: 'Solar & Clean Energy',
    trackKeywords: ['solar', 'solarization', 'clean energy', 'inverter'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-fert-1',
    tenderTitle: 'Procurement of agricultural fertilizers, urea, and DAP bags for farm extension',
    trackName: 'Education & Learning',
    trackKeywords: ['education', 'curriculum', 'textbooks', 'scholarships'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-pol-1',
    tenderTitle: 'Purchase of diesel fuel, petrol, and lubricants (POL) for government transport fleet',
    trackName: 'Vocational Training (TVET)',
    trackKeywords: ['tvet', 'vocational', 'technical training', 'youth skills'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-aud-1',
    tenderTitle: 'Hiring of chartered accountant firm for statutory external financial audit and tax review',
    trackName: 'Construction & Civil Works',
    trackKeywords: ['construction', 'civil works', 'infrastructure', 'masonry'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-meat-1',
    tenderTitle: 'Supply of fresh beef, mutton, and poultry for central prison inmates kitchen',
    trackName: 'IT Consumables & Equipment',
    trackKeywords: ['it consumables', 'computer', 'server', 'laptop'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-vac-1',
    tenderTitle: 'Procurement of anti-rabies vaccines and medical cold chain storage refrigerators',
    trackName: 'Stationery & Office Supplies',
    trackKeywords: ['stationery', 'paper', 'office supplies', 'toner'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-auc-1',
    tenderTitle: 'Disposal of condemned obsolete government vehicles and scrap metal by open public auction',
    trackName: 'Solar & Clean Energy',
    trackKeywords: ['solar', 'solarization', 'clean energy', 'solar panels'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-stamp-1',
    tenderTitle: 'Printing of revenue stamps, court fee tickets, and motorized vehicle registration books',
    trackName: 'Vocational Training (TVET)',
    trackKeywords: ['tvet', 'vocational', 'skill development', 'technical training'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-fire-1',
    tenderTitle: 'Purchase of firefighting turnout gear, breathing apparatus, and fire retardant helmets',
    trackName: 'Education & Learning',
    trackKeywords: ['education', 'curriculum', 'textbooks', 'classroom'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-jute-1',
    tenderTitle: 'Supply of wheat bags and jute gunny sacks for food department storage godowns',
    trackName: 'IT Consumables & Equipment',
    trackKeywords: ['it consumables', 'laptop', 'server', 'hardware'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-law-1',
    tenderTitle: 'Hiring of legal counsel for high court appellate tribunal tax litigation',
    trackName: 'Solar & Clean Energy',
    trackKeywords: ['solar', 'solarization', 'photovoltaic', 'clean energy'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-band-1',
    tenderTitle: 'Procurement of cotton bandages, surgical gauze rolls, and adhesive plaster tapes',
    trackName: 'Construction & Civil Works',
    trackKeywords: ['construction', 'civil works', 'infrastructure', 'masonry'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-cant-1',
    tenderTitle: 'Lease of canteen, tuck shop, and cafeteria premises at Government Postgraduate College',
    trackName: 'Vocational Training (TVET)',
    trackKeywords: ['tvet', 'vocational', 'technical training', 'youth skills'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-cow-1',
    tenderTitle: 'Supply of live dairy livestock (Sahiwal cows and Nili-Ravi buffaloes) for research farm',
    trackName: 'Stationery & Office Supplies',
    trackKeywords: ['stationery', 'paper', 'office supplies', 'toner'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-port-1',
    tenderTitle: 'Custom clearing and forwarding services for international sea port container cargo',
    trackName: 'Education & Learning',
    trackKeywords: ['education', 'curriculum', 'textbooks', 'school supplies'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-ins-1',
    tenderTitle: 'Annual comprehensive health and group life insurance coverage for permanent staff',
    trackName: 'Construction & Civil Works',
    trackKeywords: ['construction', 'civil works', 'renovation', 'infrastructure'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-vet-1',
    tenderTitle: 'Procurement of veterinary medicines, sheep deworming bolus, and cattle vaccines',
    trackName: 'IT Consumables & Equipment',
    trackKeywords: ['it consumables', 'laptop', 'server', 'computer'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-dog-1',
    tenderTitle: 'Hiring of trained security surveillance sniffer dogs and canine handlers for airport',
    trackName: 'Solar & Clean Energy',
    trackKeywords: ['solar', 'solarization', 'clean energy', 'solar panels'],
    isMatch: false,
    domain: 'cross'
  },
  {
    id: 'neg-wat-1',
    tenderTitle: 'Supply of drinking water through water tanker bowsers during emergency summer season',
    trackName: 'Vocational Training (TVET)',
    trackKeywords: ['tvet', 'vocational', 'technical training', 'youth skills'],
    isMatch: false,
    domain: 'cross'
  }
];
