/**
 * Track definitions — the *structured* half of the hybrid.
 *
 * The LLM decides which track a query belongs to and extracts values from
 * free text; everything here (question order, required files, form fields)
 * is deterministic, so the intake is complete and predictable every time.
 */
import type { ChecklistItemDef, FormField } from "./widgets";

/** ODM requirement slots, asked in order: [key, question, hint]. */
export const ODM_SLOTS: [string, string, string][] = [
  [
    "product_concept",
    "What are you looking to build? A one-line description is perfect.",
    'e.g. "a 4G GPS tracker for fleet two-wheelers"',
  ],
  [
    "key_features",
    "What are the must-have features or specs?",
    "connectivity, sensors, display, battery life, IP rating…",
  ],
  [
    "target_qty",
    "What quantities are you planning — first production run, and roughly per year?",
    "a range is fine",
  ],
  [
    "target_unit_cost",
    "Do you have a target unit cost or BoM budget?",
    '"not yet" is a valid answer',
  ],
  [
    "timeline",
    "When do you need working prototypes, and when do you want to be in production?",
    "",
  ],
  [
    "certifications_markets",
    "Which markets will this sell in, and any certifications you already know you need?",
    "BIS, CE, FCC, automotive…",
  ],
  [
    "references",
    "Any reference products, competitor devices, or existing docs we should look at?",
    "links or names are enough",
  ],
];

export const ODM_SLOT_LABELS: Record<string, string> = {
  product_concept: "Product concept",
  key_features: "Must-have features",
  target_qty: "Quantities",
  target_unit_cost: "Target unit cost",
  timeline: "Timeline",
  certifications_markets: "Markets & certifications",
  references: "References",
};

/** EMS build-package checklist for a manufacturing RFQ. */
export const EMS_CHECKLIST: ChecklistItemDef[] = [
  {
    key: "bom",
    label: "Bill of Materials (BoM)",
    accept: ".xlsx,.xls,.csv",
    required: true,
    desc: "Part numbers, quantities, designators. Ask for our level-wise BoM template if you need one.",
  },
  {
    key: "gerber",
    label: "PCB fabrication files (Gerber / ODB++)",
    accept: ".zip,.rar,.7z",
    required: true,
    desc: "A zip of your fab outputs is ideal.",
  },
  {
    key: "pnp",
    label: "Pick & place / centroid file",
    accept: ".csv,.txt,.xlsx",
    required: false,
    desc: "Speeds up SMT programming.",
  },
  {
    key: "assembly",
    label: "Assembly drawing / build notes",
    accept: ".pdf,.zip",
    required: false,
    desc: "Polarity marks, special instructions, conformal coating…",
  },
  {
    key: "cad",
    label: "3D CAD / enclosure files (STEP)",
    accept: ".step,.stp,.iges,.zip",
    required: false,
    desc: "Needed if we handle box-build or molding.",
  },
  {
    key: "test_fw",
    label: "Test spec / firmware for programming",
    accept: "*",
    required: false,
    desc: "How we should program and verify each board.",
  },
];

export const EMS_DETAILS_FORM: FormField[] = [
  {
    key: "quantity",
    label: "Quantity (first run / annual)",
    input: "text",
    required: true,
    placeholder: "e.g. 1,000 pilot + 10,000/yr",
  },
  {
    key: "target_date",
    label: "When do you need delivery?",
    input: "text",
    required: true,
    placeholder: "e.g. pilot by November",
  },
  {
    key: "notes",
    label: "Anything else — PCB specs, coating, testing?",
    input: "textarea",
    required: false,
    placeholder: "layers, finish, impedance control, burn-in…",
  },
];

export const PRODUCT_DETAILS_FORM: FormField[] = [
  {
    key: "quantity",
    label: "Quantity you're evaluating",
    input: "text",
    required: true,
    placeholder: "e.g. 500 to start",
  },
  {
    key: "timeline",
    label: "When do you need them?",
    input: "text",
    required: true,
    placeholder: "e.g. within 8 weeks",
  },
  {
    key: "customization",
    label: "Any customization? (branding, firmware, enclosure)",
    input: "textarea",
    required: false,
    placeholder: "white-label, custom firmware, different housing…",
  },
];

/**
 * Server-side extension validation for a checklist item. Returns the
 * visitor-facing error message, or null when the filename is acceptable.
 */
export function checkExtension(
  item: { accept: string; label: string },
  filename: string,
): string | null {
  if (item.accept === "*") return null;
  const allowed = item.accept.split(",").map((e) => e.trim().toLowerCase());
  const lower = filename.toLowerCase();
  if (!allowed.some((ext) => lower.endsWith(ext))) {
    return `${item.label} should be one of: ${item.accept}`;
  }
  return null;
}

/**
 * Client profiling — VERBATIM from the Eb-Master Register v1.2 Lists tab
 * (Eb-SOP_Project-Creation-and-ID-Creation_v1.2). Sector and org size are
 * register COLUMNS, never part of an identifier: IDs are meaning-free
 * (EB-FAMILY-YY-nnnn), issued register-first per the SOP's nine laws.
 */
export const SECTORS: string[] = [
  "Mobility & EV",
  "Energy & Power",
  "Industrial & Automation",
  "Electronics Manufacturing",
  "IoT & Connected Devices",
  "Consumer Electronics",
  "Medical & Healthcare",
  "Agri & Food Tech",
  "Defence & Aerospace",
  "Robotics & Drones",
  "IT, Software & AI",
  "Logistics & Infrastructure",
  "Security & Surveillance",
  "Government, Research & Institutions",
  "Individuals & Other",
];

export const ORG_SIZES: string[] = [
  "Proto-Level Startup (PL)",
  "Mid-Level Startup (ML)",
  "Enterprise (EL)",
  "EMS (EM)",
  "Government (GO)",
  "Individual / Unknown (UN)",
];

/** EB-C-26-0001 style. Serial is 4-digit, per family, restarting each January. */
export function formatEbId(family: "C" | "D" | "P", yy: string, serial: number): string {
  return `EB-${family}-${yy}-${String(serial).padStart(4, "0")}`;
}

/**
 * The one identifier that embeds a reference (SOP §2.3): the client block is
 * lifted verbatim, with a per-client 2-digit deal sequence.
 * EB-C-26-0001 + 5 → EB-D-26-0001-05.
 */
export function dealIdFor(clientId: string, seq: number): string {
  return `${clientId.replace(/^EB-C-/, "EB-D-")}-${String(seq).padStart(2, "0")}`;
}

export const CONTACT_FORM: FormField[] = [
  { key: "name", label: "Your name", input: "text", required: true, placeholder: "" },
  { key: "company", label: "Company", input: "text", required: true, placeholder: "" },
  {
    key: "email",
    label: "Work email",
    input: "email",
    required: true,
    placeholder: "you@company.com",
  },
  {
    key: "phone",
    label: "Phone / WhatsApp",
    input: "tel",
    required: true,
    placeholder: "+91…",
  },
];
