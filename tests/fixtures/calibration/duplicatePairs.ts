export interface DuplicateEvaluationPair {
  id: string;
  titleA: string;
  titleB: string;
  isDuplicate: boolean;
  notes: string;
}

export const DUPLICATE_CALIBRATION_SET: DuplicateEvaluationPair[] = [
  // --- 15 Duplicates (Republished, title formatting variations, corrigenda, cross-portal posts) ---
  {
    id: 'dup-1',
    titleA: 'Construction of 2-Room School Building at Govt Primary School Kotli',
    titleB: 'Construction of 2-Room School Building at Government Primary School Kotli',
    isDuplicate: true,
    notes: 'Abbreviation expansion (Govt -> Government)'
  },
  {
    id: 'dup-2',
    titleA: 'Supply and Installation of 100kW Solar Photovoltaic System at DHQ Hospital Jhang',
    titleB: 'Supply & Installation of 100kW Solar PV System at DHQ Hospital Jhang',
    isDuplicate: true,
    notes: 'Symbol and abbreviation variant (& vs and, PV vs Photovoltaic)'
  },
  {
    id: 'dup-3',
    titleA: 'Procurement of IT Equipment (Laptops, Desktops and Printers) FY 2026-27',
    titleB: 'Procurement of IT Equipment (Laptops, Desktops & Printers) for Financial Year 2026-27',
    isDuplicate: true,
    notes: 'FY expansion and punctuation'
  },
  {
    id: 'dup-4',
    titleA: 'Hiring of Training Service Provider for Youth Skills Development Program in Rawalpindi',
    titleB: 'Hiring of Training Service Provider (TSP) for Youth Skills Development Program, Rawalpindi',
    isDuplicate: true,
    notes: 'Acronym addition and preposition punctuation'
  },
  {
    id: 'dup-5',
    titleA: 'Corrigendum: Extension of Bid Submission Date for Supply of Office Stationery',
    titleB: 'Corrigendum - Extension of Submission Date for Supply of Office Stationery Items',
    isDuplicate: true,
    notes: 'Corrigendum notice with minor tail modifier'
  },
  {
    id: 'dup-6',
    titleA: 'Rehabilitation and Widening of Road from Main Chowk to Bypass Length 5.2 KM',
    titleB: 'Rehabilitation & Widening of Road from Main Chowk to Bypass (Length 5.20 Km)',
    isDuplicate: true,
    notes: 'Unit casing and decimal representation'
  },
  {
    id: 'dup-7',
    titleA: 'Supply of Single National Curriculum Textbooks for Elementary Classes across Sindh',
    titleB: 'Supply of SNC Textbooks for Elementary Classes throughout Sindh Province',
    isDuplicate: true,
    notes: 'Acronym variant and geographical synonym'
  },
  {
    id: 'dup-8',
    titleA: 'Installation of Solar Tube Wells with Inverter and Submersible Pumps at District Lasbela',
    titleB: 'Installation of Solar Tubewell System with Inverters and Submersible Pumps at Distt Lasbela',
    isDuplicate: true,
    notes: 'Pluralization and district abbreviation'
  },
  {
    id: 'dup-9',
    titleA: 'Procurement of High-Yield Original Toner Cartridges for Secretariat Photocopiers',
    titleB: 'Procurement of Genuine High-Yield Toner Cartridges for Secretariat Photocopier Machines',
    isDuplicate: true,
    notes: 'Synonymous modifier (Original -> Genuine)'
  },
  {
    id: 'dup-10',
    titleA: 'Turnkey Enterprise Resource Planning (ERP) System Implementation for Revenue Board',
    titleB: 'Turnkey ERP System Design, Customization and Implementation for Board of Revenue',
    isDuplicate: true,
    notes: 'Word-order transposition of entity'
  },
  {
    id: 'dup-11',
    titleA: 'Repair and Renovation of District and Sessions Court Complex at Chakwal',
    titleB: 'Repair & Renovation Work of District & Sessions Court Complex, Chakwal',
    isDuplicate: true,
    notes: 'Work suffix and ampersand'
  },
  {
    id: 'dup-12',
    titleA: 'Supply and Testing of 200kVA Three-Phase Diesel Generating Set with Soundproof Canopy',
    titleB: 'Supply, Testing & Commissioning of 200 kVA 3-Phase Diesel Generator with Canopy',
    isDuplicate: true,
    notes: 'Generator phrasing and phase abbreviation'
  },
  {
    id: 'dup-13',
    titleA: 'Hiring of Firm for Media Campaign and Production of TV Commercials on Clean Energy',
    titleB: 'Hiring of Firm for Media Campaign & Production of TVCs Regarding Clean Energy',
    isDuplicate: true,
    notes: 'TV Commercials vs TVCs'
  },
  {
    id: 'dup-14',
    titleA: 'Civil Work: Raising of Boundary Wall and Construction of Main Entrance Gate',
    titleB: 'Civil Works: Raising of Boundary Wall & Construction of Main Entrance Gate',
    isDuplicate: true,
    notes: 'Pluralization of Civil Works'
  },
  {
    id: 'dup-15',
    titleA: 'Purchase of Laboratory Equipment and Consumables for Chemistry Department',
    titleB: 'Purchase of Lab Equipment & Consumables for Dept of Chemistry',
    isDuplicate: true,
    notes: 'Department and laboratory contractions'
  },

  // --- 15 Distinct Pairs (Crucial false-merge guards: different lots, locations, years, or trades) ---
  {
    id: 'dist-loc-1',
    titleA: 'Construction of 2-Room School Building at Govt Primary School Kotli',
    titleB: 'Construction of 2-Room School Building at Govt Primary School Mirpur',
    isDuplicate: false,
    notes: 'Different geographical locations (Kotli vs Mirpur)'
  },
  {
    id: 'dist-lot-1',
    titleA: 'Procurement of IT Equipment - Lot 1: Laptops and Desktops',
    titleB: 'Procurement of IT Equipment - Lot 2: Network Switches and Firewalls',
    isDuplicate: false,
    notes: 'Different project lots with distinct scopes'
  },
  {
    id: 'dist-scale-1',
    titleA: 'Supply and Installation of 50kW Solar System at THQ Hospital Taunsa',
    titleB: 'Supply and Installation of 500kW Solar System at Taunsa Barrage',
    isDuplicate: false,
    notes: 'Different facilities and 10x capacity difference'
  },
  {
    id: 'dist-year-1',
    titleA: 'Annual Procurement of Stationery Items for Financial Year 2025-26',
    titleB: 'Annual Procurement of Stationery Items for Financial Year 2026-27',
    isDuplicate: false,
    notes: 'Different fiscal years'
  },
  {
    id: 'dist-trade-1',
    titleA: 'Hiring of Training Service Provider for Industrial Electrician Trade',
    titleB: 'Hiring of Training Service Provider for Graphic Design and Animation Trade',
    isDuplicate: false,
    notes: 'Completely different vocational trade curricula'
  },
  {
    id: 'dist-pkg-1',
    titleA: 'Rehabilitation of Rural Road Package 01 from Morah to Chak 45',
    titleB: 'Rehabilitation of Rural Road Package 02 from Morah to Basti Riaz',
    isDuplicate: false,
    notes: 'Distinct contract packages with different routes'
  },
  {
    id: 'dist-dept-1',
    titleA: 'Supply of Medicines for Cardiology Department at Mayo Hospital',
    titleB: 'Supply of Medicines for Oncology Department at Mayo Hospital',
    isDuplicate: false,
    notes: 'Different clinical hospital departments'
  },
  {
    id: 'dist-distr-1',
    titleA: 'Construction of Boundary Wall at Judicial Complex Swat',
    titleB: 'Construction of Boundary Wall at Judicial Complex Mardan',
    isDuplicate: false,
    notes: 'Different administrative districts'
  },
  {
    id: 'dist-dept-2',
    titleA: 'Procurement of Uniforms and Protective Clothing for Traffic Wardens',
    titleB: 'Procurement of Uniforms and Protective Clothing for Prison Warders',
    isDuplicate: false,
    notes: 'Traffic Wardens vs Prison Warders (different agencies)'
  },
  {
    id: 'dist-uc-1',
    titleA: 'Installation of Solar Water Filtration Plant at Union Council 12',
    titleB: 'Installation of Solar Water Filtration Plant at Union Council 48',
    isDuplicate: false,
    notes: 'Different Union Councils'
  },
  {
    id: 'dist-exam-1',
    titleA: 'Printing and Supply of Matriculation Examination Answer Sheets 2026',
    titleB: 'Printing and Supply of Intermediate Examination Answer Sheets 2026',
    isDuplicate: false,
    notes: 'Matriculation (10th) vs Intermediate (12th)'
  },
  {
    id: 'dist-river-1',
    titleA: 'Civil Works for Construction of Bridge over River Swat',
    titleB: 'Civil Works for Construction of Bridge over River Kabul',
    isDuplicate: false,
    notes: 'Different major rivers'
  },
  {
    id: 'dist-dev-1',
    titleA: 'Procurement of 100 Enterprise Desktop Computers for Computer Labs',
    titleB: 'Procurement of 100 Enterprise Tablet Computers for Field Surveyors',
    isDuplicate: false,
    notes: 'Desktop PCs vs Handheld Survey Tablets'
  },
  {
    id: 'dist-bench-1',
    titleA: 'Janitorial Services for High Court Principal Seat Lahore',
    titleB: 'Janitorial Services for High Court Multan Bench',
    isDuplicate: false,
    notes: 'Principal seat vs regional bench'
  },
  {
    id: 'dist-scope-1',
    titleA: 'Consultancy Services for Feasibility Study of Hydro Power Project',
    titleB: 'Consultancy Services for Environmental Impact Assessment of Hydro Power Project',
    isDuplicate: false,
    notes: 'Feasibility study vs Environmental Impact Assessment'
  }
];
