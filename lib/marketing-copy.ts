export const MARKETING_SITE_URL = "https://clinicflow.fit";

export const marketingCopy = {
  brand: "ClinicFlow",
  nav: {
    label: "Main navigation",
    menu: "Open navigation menu",
    menuTitle: "Navigate ClinicFlow",
    product: "Product",
    features: "Features",
    security: "Security",
    pricing: "Pricing",
    faq: "FAQ",
    login: "Log in",
    earlyAccess: "Request early access",
  },
  hero: {
    eyebrow: "Clinic operations, without the operational noise",
    title: "A clearer clinic day, from first booking to final report.",
    body:
      "ClinicFlow brings scheduling, patient context, billing, follow-ups, and team workflows into one calm workspace for private clinics.",
    primary: "Request early access",
    openPrimary: "Create your clinic",
    secondary: "See the product",
    assurances: ["Role-based access", "No card required", "Guided onboarding"],
    screenshotAlt:
      "ClinicFlow administrator dashboard showing daily appointments, revenue, pending confirmations, and clinic activity using fictional demo data.",
    screenshotCaption: "The full clinic day, visible at a glance",
  },
  proof: {
    eyebrow: "Early access, deliberately paced",
    title: "We onboard a limited clinic cohort each week.",
    body:
      "A smaller cohort means careful setup, direct feedback, and a product shaped around real private-clinic operations—not fabricated testimonials.",
    progress: (accepted: number, limit: number) =>
      `${accepted} of ${limit} clinic spots taken this week`,
    progressLabel: "Weekly early-access cohort progress",
  },
  product: {
    eyebrow: "One connected operating system",
    title: "Follow the work, not a maze of tabs and spreadsheets.",
    body:
      "Each view is built around the next decision your team needs to make. The screenshots below come from a repeatably seeded demo clinic with entirely fictional records.",
    demoNotice: "Product screens show fictional demo data only.",
    workflows: [
      {
        time: "08:00",
        label: "Schedule",
        title: "See the day before the first patient arrives.",
        body:
          "A readable week calendar keeps working hours, breaks, appointment states, and the current time easy to scan.",
        bullets: [
          "Week, day, and month views",
          "Clear status and working-hour hierarchy",
          "Doctor and department filters",
        ],
        desktop: "/marketing/schedule-desktop.avif",
        mobile: "/marketing/schedule-mobile.avif",
        alt: "ClinicFlow week calendar showing fictional appointments across clinic working hours, doctors, and appointment statuses.",
      },
      {
        time: "09:30",
        label: "Front desk",
        title: "Give reception the context to keep the queue moving.",
        body:
          "Patient records, assigned doctors, contact details, and clinic file numbers stay searchable in one dependable directory.",
        bullets: [
          "Fast patient search and filtering",
          "Role-appropriate access",
          "Archive and recovery workflows",
        ],
        desktop: "/marketing/patients-desktop.avif",
        mobile: "/marketing/patients-mobile.avif",
        alt: "ClinicFlow patient directory showing fictional patient records, assigned clinicians, departments, and contact information.",
      },
      {
        time: "13:00",
        label: "Patient record",
        title: "Keep care history and billing context together.",
        body:
          "A patient profile connects appointments, follow-ups, medical notes, packages, balances, and documents without losing the clinical thread.",
        bullets: [
          "Longitudinal patient context",
          "Packages, deposits, and balances",
          "Follow-up and medical-note history",
        ],
        desktop: "/marketing/patient-record-desktop.avif",
        mobile: "/marketing/patient-record-mobile.avif",
        alt: "ClinicFlow fictional patient profile with billing summary, package information, appointments, follow-ups, and medical notes.",
      },
      {
        time: "17:30",
        label: "Reports",
        title: "Close the day with numbers the team can explain.",
        body:
          "Revenue and operational reports preserve canonical clinic amounts while making workload, outcomes, and collections easier to review.",
        bullets: [
          "Revenue and payment-method breakdowns",
          "Doctor and receptionist performance views",
          "Print-ready operational reports",
        ],
        desktop: "/marketing/reports-desktop.avif",
        mobile: "/marketing/reports-mobile.avif",
        alt: "ClinicFlow revenue report showing fictional clinic collections, payment methods, and transaction detail.",
      },
    ],
  },
  features: {
    eyebrow: "The daily essentials",
    title: "A useful core for every clinic role.",
    body:
      "ClinicFlow is designed to make core clinic work dependable before adding automation around it.",
    items: [
      {
        title: "Appointments",
        body: "Plan clinic capacity with working hours, doctor schedules, status flows, and conflict-aware booking.",
      },
      {
        title: "Patient records",
        body: "Keep patient details, visits, documents, notes, packages, and balances in one connected record.",
      },
      {
        title: "Billing",
        body: "Record services, deposits, split payments, insurance amounts, and outstanding settlements clearly.",
      },
      {
        title: "Follow-ups",
        body: "Track completed and pending follow-ups so important patient contact does not disappear into a note.",
      },
      {
        title: "Reports",
        body: "Review revenue, cancellations, no-shows, follow-ups, and team performance without rebuilding spreadsheets.",
      },
      {
        title: "Team and roles",
        body: "Give administrators, managers, receptionists, and doctors the views and actions appropriate to their work.",
      },
    ],
  },
  security: {
    eyebrow: "Trust is part of the architecture",
    title: "Clinic data stays inside deliberate boundaries.",
    body:
      "Healthcare buyers should not have to infer how access works. ClinicFlow states the current controls plainly and avoids compliance claims it has not earned.",
    items: [
      {
        title: "Tenant isolation",
        body: "Clinic records are separated by clinic throughout the data model and application paths.",
      },
      {
        title: "Row-level security",
        body: "Database policies enforce clinic and role boundaries as a backstop to application authorization.",
      },
      {
        title: "Role-based access",
        body: "Administrators, managers, receptionists, and doctors receive distinct permissions and views.",
      },
      {
        title: "Audit trail",
        body: "Sensitive operational changes are recorded so important platform and clinic actions remain traceable.",
      },
      {
        title: "Data portability",
        body: "Clinic administrators can export clinic data through a guarded export workflow.",
      },
    ],
    note:
      "ClinicFlow does not claim HIPAA, PDPL, or other formal certification on this website. Legal and regulatory review remains market-specific.",
  },
  pricing: {
    eyebrow: "Plans in formation",
    title: "Pricing is being finalized with early clinics.",
    body:
      "The structure is ready for three clear plans. Final prices and plan details will be published before general availability.",
    cta: "Join the early cohort",
    pending: "Final details pending",
    tiers: [
      {
        name: "Basic",
        description: "Core clinic management for teams building a reliable daily workflow.",
        highlights: ["Appointments and patients", "Billing and reports", "Team access"],
      },
      {
        name: "Pro",
        description: "More automation and communication capacity for growing clinics.",
        highlights: ["Everything in Basic", "Higher usage limits", "Advanced operations"],
      },
      {
        name: "Pro + AI",
        description: "The future assisted-workflow tier, introduced only after its safety gates are complete.",
        highlights: ["Everything in Pro", "AI usage allowance", "Assisted workflows"],
      },
    ],
  },
  earlyAccess: {
    eyebrow: "Early access",
    title: "Bring your clinic into a calmer workflow.",
    body:
      "Tell us about your clinic. We review each request and guide accepted teams through setup.",
    button: "Request an invitation",
    openButton: "Create your clinic",
    dialogTitle: "Request early access",
    dialogDescription:
      "Share a few details about your clinic. We will contact you after reviewing the request.",
  },
  faq: {
    eyebrow: "Questions, answered plainly",
    title: "What clinics ask before joining.",
    expand: "+",
    items: [
      {
        question: "Who is ClinicFlow for?",
        answer:
          "Independent and multi-doctor private clinics that want one connected system for daily operations.",
      },
      {
        question: "Which team roles can use it?",
        answer:
          "ClinicFlow currently supports administrators, managers, receptionists, and doctors with role-appropriate access.",
      },
      {
        question: "What does early access include?",
        answer:
          "Accepted clinics receive guided onboarding and a direct feedback channel while the product prepares for general availability.",
      },
      {
        question: "Is a payment card required?",
        answer:
          "No card is required to request early access. Commercial plans are still being finalized.",
      },
      {
        question: "Can we move our data out?",
        answer:
          "Clinic administrators have a guarded data-export workflow for the clinic records currently supported by the product.",
      },
      {
        question: "Does ClinicFlow support multiple currencies?",
        answer:
          "Clinic records keep their canonical operating currency. Each user can choose a supported display currency for clearly marked approximate conversions.",
      },
      {
        question: "Is ClinicFlow formally certified for a healthcare regulation?",
        answer:
          "No certification claim is made here. Compliance and legal readiness require market-specific review before launch with real clinic data.",
      },
      {
        question: "When will final pricing be available?",
        answer:
          "Final plan prices and terms will be published before general availability, after the early-clinic validation period.",
      },
    ],
  },
  footer: {
    tagline: "A calmer operating system for private clinics.",
    email: "hello@clinicflow.app",
    login: "Team login",
    privacy: "Privacy Policy",
    terms: "Terms of Service",
    legal: "Final legal text is pending professional review.",
    copyright: (year: number) => `© ${year} ClinicFlow`,
  },
  legal: {
    back: "Back to ClinicFlow",
    noticeTitle: "Pending legal review",
    noticeBody:
      "This page is a product-stage outline, not final legal text. It describes current intent only and does not create definitive commitments, retention periods, certifications, or contractual terms.",
    privacy: {
      title: "Privacy Policy",
      description: "A plain-language outline of ClinicFlow’s intended data-handling approach.",
      updated: "Draft outline — July 2026",
      sections: [
        {
          title: "Purpose and scope",
          body: "The final policy is intended to explain what information ClinicFlow processes when clinics evaluate or use the service, why it is needed, and which parties are involved.",
        },
        {
          title: "Early-access requests",
          body: "Early-access requests currently ask for clinic and owner contact details so the team can review and respond to the request. The final policy will describe the lawful basis and handling period after legal review.",
        },
        {
          title: "Clinic data and access",
          body: "The product is designed around tenant isolation, database row-level security, and role-based access. Clinic administrators control staff access within their clinic.",
        },
        {
          title: "Service providers and locations",
          body: "The final policy will identify approved infrastructure and service providers, processing locations, and any required transfer safeguards before real clinic data is onboarded in a market.",
        },
        {
          title: "Choices and requests",
          body: "Clinic administrators have a guarded data-export workflow. Final access, correction, deletion, and contact procedures remain subject to legal and operational review.",
        },
        {
          title: "Contact",
          body: "Questions about this draft or the upcoming final policy can be sent to hello@clinicflow.app.",
        },
      ],
    },
    terms: {
      title: "Terms of Service",
      description: "A non-binding outline of topics planned for ClinicFlow’s service terms.",
      updated: "Draft outline — July 2026",
      sections: [
        {
          title: "Service overview",
          body: "The final terms are intended to describe access to ClinicFlow’s clinic-operations software, supported features, account responsibilities, and service boundaries.",
        },
        {
          title: "Early-access stage",
          body: "ClinicFlow is currently onboarding a limited cohort. Product behavior, availability, and plan structure may continue to evolve before general availability.",
        },
        {
          title: "Clinic responsibilities",
          body: "Final terms are expected to address authorized users, accurate account information, lawful handling of clinic and patient data, and responsible use of the service.",
        },
        {
          title: "Plans and payment",
          body: "Prices, billing arrangements, renewal rules, and cancellation terms have not been finalized and are not stated or implied by this outline.",
        },
        {
          title: "Availability and changes",
          body: "Any final commitments about uptime, support, warranties, liability, or service changes will be added only after professional legal and commercial review.",
        },
        {
          title: "Contact",
          body: "Questions about this draft or the upcoming final terms can be sent to hello@clinicflow.app.",
        },
      ],
    },
  },
} as const;
