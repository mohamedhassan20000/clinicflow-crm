import "server-only";

import type { UserRole } from "@/lib/rbac";
import type { AiUserPermissionKey } from "@/lib/ai/permissions";
import type { NavigationTargetId } from "@/lib/ai/help/navigation";
import { WHATSAPP_FEATURE } from "@/lib/ai/help/navigation";
import {
  AI_ASSISTANT_CUSTOMIZATION_FEATURE,
  AI_FINANCIAL_INSIGHTS_FEATURE,
} from "@/lib/ai/authorization";

/**
 * The curated ClinicFlow help corpus (P4.7A).
 *
 * ## What this is
 *
 * Static, versioned, in-repository product documentation — the *only* thing the
 * assistant may answer a "how do I…" question from. It contains no tenant data,
 * so it is injection-safe by construction: every string here was written by the
 * team and reviewed in a pull request, which is precisely why the assistant is
 * allowed to treat it as trustworthy when it treats every database string as
 * hostile.
 *
 * ## The rule that makes it worth having
 *
 * **An article may only describe behavior that exists.** Each article below was
 * written against the actual route, its actual role guard, and the actual UI
 * copy in `messages/*.json` — not from memory of what the product ought to do.
 * A corpus that drifts is worse than no corpus, because the assistant states its
 * contents with confidence and the user has no way to tell a stale step from a
 * current one. Two mechanisms defend this:
 *
 *  1. **Maintenance rule (roadmap acceptance):** every phase that changes a
 *     user-facing surface updates the affected articles as part of that phase.
 *  2. **Tests:** `roles` and `navigationTarget` are cross-checked against the
 *     navigation registry, so an article can never advertise a destination whose
 *     own role guard contradicts it.
 *
 * ## Authoring convention
 *
 * - `id` — stable kebab-case slug. It is quoted back to the user as the citation
 *   and may appear in logs, so renaming one is a breaking change; add a new
 *   article instead.
 * - `navigationTarget` — the destination this article teaches. It is what turns
 *   an answer into a working deep link, and what makes the answer *honest*: the
 *   article is only served with its steps when that target resolves as
 *   `available` for the asking user.
 * - `roles` — who this workflow is for. Must be a subset of the navigation
 *   target's roles (asserted by test). Deny-by-default: a role absent here never
 *   sees the article at all.
 * - `requiredFeatures` / `requiredUserPermission` — a workflow belonging to a
 *   module or premium capability the clinic/user does not have is not described
 *   at all. See `filterArticlesForUser` for why absence, not a "you can't have
 *   this" notice, is the right answer for these two.
 * - `en` / `ar` — full parity. Both locales carry the same steps in the same
 *   order; neither is a translation stub. Arabic is a first-class authoring
 *   language here, not a machine rendering of the English.
 * - `keywords` — what users actually type, including colloquial and misspelled
 *   forms. Matched after Arabic/English normalization, so diacritics and
 *   alef/taa-marbuta variants need not be repeated.
 */
export type HelpArticleContent = {
  title: string;
  /** One or two sentences: what this workflow is and when to use it. */
  summary: string;
  /** What must already be true before the steps work. May be empty. */
  prerequisites: readonly string[];
  /** Ordered, concrete UI steps. Each names something the user can see. */
  steps: readonly string[];
  /** Caveats worth stating unprompted. May be empty. */
  notes: readonly string[];
  keywords: readonly string[];
};

export type HelpArticle = {
  id: string;
  navigationTarget: NavigationTargetId;
  roles: readonly UserRole[];
  requiredFeatures?: readonly string[];
  requiredUserPermission?: AiUserPermissionKey;
  en: HelpArticleContent;
  ar: HelpArticleContent;
};

const ALL_STAFF: readonly UserRole[] = ["admin", "manager", "receptionist", "doctor"];
const ADMIN_RECEPTION: readonly UserRole[] = ["admin", "receptionist"];
const ADMIN_MANAGER: readonly UserRole[] = ["admin", "manager"];
const ADMIN_MANAGER_RECEPTION: readonly UserRole[] = ["admin", "manager", "receptionist"];

export const HELP_ARTICLES: readonly HelpArticle[] = [
  {
    id: "register-new-patient",
    navigationTarget: "patient_new",
    roles: ADMIN_RECEPTION,
    en: {
      title: "Register a new patient",
      summary:
        "Create a patient record so the patient can be booked, invoiced, and followed up.",
      prerequisites: [],
      steps: [
        "Open Patients from the sidebar.",
        "Choose New patient.",
        "Fill in the patient's name, phone number, and the rest of the identifying details on the form.",
        "Save the form. The new patient's file opens, and the patient can now be selected when booking an appointment.",
      ],
      notes: [
        "Doctors can view patient files but do not create them. Managers cannot access the Patients page. Ask an administrator or a receptionist to register a patient.",
      ],
      keywords: [
        "add patient",
        "new patient",
        "register patient",
        "create patient file",
        "enroll patient",
        "add a new patient record",
      ],
    },
    ar: {
      title: "تسجيل مريض جديد",
      summary: "إنشاء ملف للمريض حتى يمكن حجز المواعيد له وإصدار الفواتير ومتابعته.",
      prerequisites: [],
      steps: [
        "افتح «المرضى» من القائمة الجانبية.",
        "اختر «مريض جديد».",
        "أدخل اسم المريض ورقم هاتفه وبقية البيانات التعريفية في النموذج.",
        "احفظ النموذج. سيُفتح ملف المريض الجديد، ويصبح متاحًا للاختيار عند حجز موعد.",
      ],
      notes: [
        "يمكن للأطباء عرض ملفات المرضى لكن لا يمكنهم إنشاؤها. لا يمكن للمديرين الوصول إلى صفحة «المرضى». اطلب من مسؤول العيادة أو موظف الاستقبال تسجيل المريض.",
      ],
      keywords: [
        "إضافة مريض",
        "مريض جديد",
        "تسجيل مريض",
        "إنشاء ملف مريض",
        "ادخال مريض",
      ],
    },
  },
  {
    id: "find-patient-file",
    navigationTarget: "patients_list",
    // Managers have no patients page; mirrors the navigation target's roles.
    roles: ["admin", "receptionist", "doctor"],
    en: {
      title: "Find a patient's file",
      summary: "Look up an existing patient by name, phone number, or file number.",
      prerequisites: [],
      steps: [
        "Open Patients from the sidebar.",
        "Type the patient's name, phone number, or file number into the search box.",
        "Select the patient from the results to open their file.",
      ],
      notes: [
        "The Patients-page search matches stored names, phone numbers, and file numbers, including partial text matches.",
        "For Arabic/English spelling variants or approximate names, ask this assistant to use its ranked bilingual patient search.",
      ],
      keywords: [
        "find patient",
        "search patient",
        "look up patient",
        "patient file number",
        "open patient record",
      ],
    },
    ar: {
      title: "البحث عن ملف مريض",
      summary: "الوصول إلى مريض مسجَّل بالاسم أو رقم الهاتف أو رقم الملف.",
      prerequisites: [],
      steps: [
        "افتح «المرضى» من القائمة الجانبية.",
        "اكتب اسم المريض أو رقم هاتفه أو رقم ملفه في مربع البحث.",
        "اختر المريض من النتائج لفتح ملفه.",
      ],
      notes: [
        "يطابق البحث في صفحة المرضى الأسماء وأرقام الهاتف وأرقام الملفات المخزنة، بما في ذلك المطابقة الجزئية للنص.",
        "للبحث عن تهجئات عربية أو إنجليزية بديلة أو أسماء تقريبية، اطلب من هذا المساعد استخدام بحث المرضى الثنائي اللغة والمرتّب حسب التطابق.",
      ],
      keywords: [
        "البحث عن مريض",
        "ايجاد مريض",
        "رقم ملف المريض",
        "فتح ملف مريض",
      ],
    },
  },
  {
    id: "book-appointment",
    navigationTarget: "appointment_new",
    roles: ADMIN_RECEPTION,
    en: {
      title: "Book an appointment",
      summary: "Schedule a patient with a doctor at an available time.",
      prerequisites: [
        "The patient already has a file. If not, register the patient first.",
        "The doctor has working hours configured for the day you are booking.",
      ],
      steps: [
        "Open Appointments from the sidebar.",
        "Choose New appointment.",
        "Select the patient, the department, and the doctor.",
        "Pick the date and one of the available time slots offered for that doctor.",
        "Save the appointment. It appears on the calendar with the status Pending.",
      ],
      notes: [
        "Only open slots are offered — times the doctor is already booked or not working are not shown.",
        "You can ask this assistant to check a doctor's open slots on a given date before you book.",
      ],
      keywords: [
        "book appointment",
        "new appointment",
        "schedule patient",
        "make a booking",
        "reserve a slot",
        "appointment for patient",
      ],
    },
    ar: {
      title: "حجز موعد",
      summary: "جدولة موعد لمريض مع طبيب في وقت متاح.",
      prerequisites: [
        "أن يكون للمريض ملف مسجَّل مسبقًا؛ وإلا فسجِّل المريض أولًا.",
        "أن تكون ساعات عمل الطبيب مضبوطة لليوم المطلوب.",
      ],
      steps: [
        "افتح «المواعيد» من القائمة الجانبية.",
        "اختر «موعد جديد».",
        "حدّد المريض والقسم والطبيب.",
        "اختر التاريخ ثم أحد الأوقات المتاحة المعروضة لذلك الطبيب.",
        "احفظ الموعد. سيظهر في التقويم بحالة «قيد الانتظار».",
      ],
      notes: [
        "تُعرض الأوقات الشاغرة فقط — لا تظهر الأوقات المحجوزة أو خارج دوام الطبيب.",
        "يمكنك أن تطلب من هذا المساعد التحقق من الأوقات المتاحة لطبيب في تاريخ معيّن قبل الحجز.",
      ],
      keywords: [
        "حجز موعد",
        "موعد جديد",
        "جدولة مريض",
        "عمل حجز",
        "احجز للمريض",
      ],
    },
  },
  {
    id: "update-appointment-status",
    navigationTarget: "appointments_calendar",
    roles: ADMIN_RECEPTION,
    en: {
      title: "Update an appointment's status",
      summary:
        "Move an appointment through its lifecycle: pending, confirmed, arrived, in session, completed, cancelled, or no-show.",
      prerequisites: ["The appointment already exists on the calendar."],
      steps: [
        "Open Appointments from the sidebar.",
        "Find the appointment on the calendar for the relevant day.",
        "Open the appointment and choose the new status.",
        "Confirm. A toast reports the change, and the calendar updates.",
      ],
      notes: [
        "Marking an appointment Completed is what makes it eligible for a follow-up call and includes it in revenue and performance reporting.",
        "Cancellations and no-shows feed the cancellation and no-show reports, so recording them accurately keeps those reports meaningful.",
      ],
      keywords: [
        "appointment status",
        "mark as arrived",
        "complete appointment",
        "cancel appointment",
        "no show",
        "confirm appointment",
      ],
    },
    ar: {
      title: "تحديث حالة الموعد",
      summary:
        "نقل الموعد بين حالاته: قيد الانتظار، مؤكَّد، حضر، في الجلسة، مكتمل، ملغى، أو لم يحضر.",
      prerequisites: ["أن يكون الموعد موجودًا في التقويم."],
      steps: [
        "افتح «المواعيد» من القائمة الجانبية.",
        "حدّد الموعد في تقويم اليوم المطلوب.",
        "افتح الموعد واختر الحالة الجديدة.",
        "أكِّد العملية. ستظهر رسالة تأكيد ويُحدَّث التقويم.",
      ],
      notes: [
        "تحديد الموعد كـ«مكتمل» هو ما يجعله مؤهلًا لمكالمة المتابعة ويُدرجه في تقارير الإيرادات والأداء.",
        "تغذّي حالات الإلغاء وعدم الحضور تقاريرهما، لذا فإن تسجيلها بدقة يحافظ على قيمة تلك التقارير.",
      ],
      keywords: [
        "حالة الموعد",
        "تسجيل الحضور",
        "إنهاء الموعد",
        "إلغاء موعد",
        "لم يحضر",
        "تأكيد موعد",
      ],
    },
  },
  {
    id: "record-payment-and-invoice",
    navigationTarget: "appointments_calendar",
    roles: ADMIN_RECEPTION,
    en: {
      title: "Invoice a session and record payment",
      summary:
        "Charge a completed session, take payment, and send the invoice to the patient.",
      prerequisites: [
        "The session's services and prices are configured under Settings → Services.",
      ],
      steps: [
        "Open Appointments and select the session you are billing.",
        "Add the services performed to the session so the total is calculated.",
        "Record the payment, choosing the payment method (cash, credit card, PayPal, bank transfer, or insurance).",
        "If the patient pays only part of the total, record the amount received — the remainder is tracked as an outstanding balance.",
        "Choose Send to patient to deliver the invoice by email, and by WhatsApp when the clinic has WhatsApp connected.",
      ],
      notes: [
        "A patient can also hold a deposit on their account, which can be applied against a later invoice.",
        "Outstanding balances remain due and are reported separately from collected revenue.",
      ],
      keywords: [
        "issue invoice",
        "create invoice",
        "record payment",
        "bill patient",
        "take payment",
        "send invoice",
        "receipt",
        "charge for session",
      ],
    },
    ar: {
      title: "إصدار فاتورة الجلسة وتسجيل الدفع",
      summary: "احتساب قيمة جلسة مكتملة، وتسجيل الدفع، وإرسال الفاتورة إلى المريض.",
      prerequisites: ["أن تكون خدمات الجلسة وأسعارها مضبوطة في «الإعدادات ← الخدمات»."],
      steps: [
        "افتح «المواعيد» واختر الجلسة المراد إصدار فاتورتها.",
        "أضف الخدمات المقدَّمة إلى الجلسة ليُحتسب الإجمالي.",
        "سجّل الدفع واختر طريقة السداد (نقدًا، بطاقة ائتمان، باي بال، تحويل بنكي، أو تأمين).",
        "إذا سدّد المريض جزءًا من المبلغ فقط، فسجّل المبلغ المستلم — ويُتابَع الباقي كرصيد مستحق.",
        "اختر «إرسال إلى المريض» لإرسال الفاتورة بالبريد الإلكتروني، وعبر واتساب إذا كان مرتبطًا بالعيادة.",
      ],
      notes: [
        "يمكن أن يكون للمريض رصيد مقدَّم في حسابه يُخصم لاحقًا من فاتورة قادمة.",
        "تبقى المبالغ المستحقة قائمة، وتُعرض منفصلة عن الإيرادات المحصَّلة.",
      ],
      keywords: [
        "إصدار فاتورة",
        "إنشاء فاتورة",
        "تسجيل دفعة",
        "محاسبة المريض",
        "استلام دفعة",
        "إرسال فاتورة",
        "إيصال",
      ],
    },
  },
  {
    id: "record-followup",
    navigationTarget: "followups",
    roles: ADMIN_RECEPTION,
    en: {
      title: "Record a follow-up call",
      summary:
        "Log the outcome of a post-session check-in call with a patient.",
      prerequisites: ["The patient's session is marked Completed."],
      steps: [
        "Open Follow-ups from the sidebar.",
        "Find the patient under Awaiting follow-up.",
        "Choose Record follow-up.",
        "Select the outcome: All fine, Reported a problem, No response, or Note taken.",
        "Add optional context in the notes field, then save.",
      ],
      notes: [
        "Recorded follow-ups move to Completed follow-ups and appear in the follow-ups report.",
        "A follow-up can be edited after it is recorded if the outcome changes.",
      ],
      keywords: [
        "follow up call",
        "record follow up",
        "call patient after session",
        "post visit call",
        "aftercare",
      ],
    },
    ar: {
      title: "تسجيل مكالمة متابعة",
      summary: "تسجيل نتيجة مكالمة الاطمئنان على المريض بعد الجلسة.",
      prerequisites: ["أن تكون جلسة المريض محددة كـ«مكتملة»."],
      steps: [
        "افتح «المتابعات» من القائمة الجانبية.",
        "حدّد المريض ضمن «في انتظار المتابعة».",
        "اختر «تسجيل متابعة».",
        "اختر النتيجة: بخير، أبلغ عن مشكلة، لا يوجد رد، أو تم تدوين ملاحظة.",
        "أضف تفاصيل اختيارية في حقل الملاحظات ثم احفظ.",
      ],
      notes: [
        "تنتقل المتابعات المسجَّلة إلى «المتابعات المكتملة» وتظهر في تقرير المتابعات.",
        "يمكن تعديل المتابعة بعد تسجيلها إذا تغيّرت النتيجة.",
      ],
      keywords: [
        "مكالمة متابعة",
        "تسجيل متابعة",
        "الاتصال بالمريض بعد الجلسة",
        "متابعة ما بعد الزيارة",
      ],
    },
  },
  {
    id: "reply-patient-whatsapp",
    navigationTarget: "inbox",
    roles: ADMIN_RECEPTION,
    requiredFeatures: [WHATSAPP_FEATURE],
    en: {
      title: "Reply to a patient on WhatsApp",
      summary:
        "Answer incoming patient WhatsApp messages and link a conversation to the right patient file.",
      prerequisites: ["The clinic's WhatsApp number is connected."],
      steps: [
        "Open Inbox from the sidebar.",
        "Select the conversation you want to answer.",
        "If the sender is not yet linked to a patient, choose Link patient and pick the patient file.",
        "Type your reply and choose Send reply.",
      ],
      notes: [
        "Freeform replies are only permitted inside WhatsApp's 24-hour service window. Once it closes, you must send an approved template until the patient writes again.",
        "A conversation can be assigned to a staff member, and closed or reopened as it is handled.",
      ],
      keywords: [
        "whatsapp",
        "reply to patient",
        "inbox message",
        "patient conversation",
        "answer message",
        "link conversation to patient",
      ],
    },
    ar: {
      title: "الرد على مريض عبر واتساب",
      summary:
        "الرد على رسائل المرضى الواردة عبر واتساب وربط المحادثة بملف المريض الصحيح.",
      prerequisites: ["أن يكون رقم واتساب الخاص بالعيادة مرتبطًا."],
      steps: [
        "افتح «صندوق الوارد» من القائمة الجانبية.",
        "اختر المحادثة التي تريد الرد عليها.",
        "إذا لم يكن المُرسِل مرتبطًا بمريض، فاختر «ربط مريض» وحدّد ملف المريض.",
        "اكتب ردك ثم اختر «إرسال الرد».",
      ],
      notes: [
        "الردود الحرة متاحة فقط داخل نافذة الخدمة البالغة 24 ساعة في واتساب. بعد انتهائها يلزم إرسال قالب معتمد حتى يراسلك المريض مجددًا.",
        "يمكن إسناد المحادثة إلى موظف، وإغلاقها أو إعادة فتحها أثناء معالجتها.",
      ],
      keywords: [
        "واتساب",
        "الرد على مريض",
        "رسالة واردة",
        "محادثة مريض",
        "ربط محادثة بمريض",
      ],
    },
  },
  {
    id: "configure-reminders",
    navigationTarget: "settings_messaging",
    roles: ADMIN_MANAGER,
    en: {
      title: "Configure patient reminders and messaging",
      summary:
        "Control automatic appointment reminders and overdue-invoice follow-ups, and review the clinic's available messaging channels.",
      prerequisites: ["You are an administrator or a manager of the clinic."],
      steps: [
        "Open Settings from the sidebar.",
        "Go to the Messaging section.",
        "Adjust appointment-reminder and overdue-invoice follow-up settings, including the email wording, then save.",
        "If the clinic has WhatsApp, review its connection separately on the same page.",
      ],
      notes: [
        "Reminder and email follow-up settings remain available without WhatsApp. WhatsApp delivery requires that feature and an active connection.",
        "Only an administrator can change the WhatsApp connection itself; managers can review it and manage reminders.",
        "The message wording patients receive comes from Settings → Templates.",
      ],
      keywords: [
        "reminders",
        "reminder settings",
        "configure whatsapp",
        "patient notifications",
        "messaging settings",
        "automatic messages",
      ],
    },
    ar: {
      title: "ضبط تذكيرات المرضى والمراسلة",
      summary: "ضبط تذكيرات المواعيد التلقائية ومتابعات الفواتير المتأخرة، ومراجعة قنوات المراسلة المتاحة للعيادة.",
      prerequisites: ["أن تكون مسؤولًا أو مديرًا في العيادة."],
      steps: [
        "افتح «الإعدادات» من القائمة الجانبية.",
        "انتقل إلى قسم «المراسلة».",
        "عدّل إعدادات تذكير المواعيد ومتابعات الفواتير المتأخرة، بما فيها صياغة البريد الإلكتروني، ثم احفظ.",
        "إذا كانت ميزة واتساب متاحة للعيادة، فراجع حالة ارتباطها بشكل منفصل في الصفحة نفسها.",
      ],
      notes: [
        "تبقى إعدادات التذكير والمتابعة بالبريد الإلكتروني متاحة دون واتساب. ويتطلب الإرسال عبر واتساب توفر الميزة وارتباطًا نشطًا.",
        "تغيير ارتباط واتساب نفسه متاح للمسؤول فقط؛ أما المدير فيمكنه مراجعته وإدارة التذكيرات.",
        "تأتي صياغة الرسائل التي يستلمها المرضى من «الإعدادات ← القوالب».",
      ],
      keywords: [
        "التذكيرات",
        "إعدادات التذكير",
        "ضبط واتساب",
        "إشعارات المرضى",
        "إعدادات المراسلة",
        "الرسائل التلقائية",
      ],
    },
  },
  {
    id: "add-staff-member",
    navigationTarget: "settings_staff",
    roles: ADMIN_MANAGER,
    en: {
      title: "Add a staff member",
      summary:
        "Create a clinic staff account. Managers can add non-admin staff; administrators can add any supported staff role.",
      prerequisites: ["You are an administrator or a manager of the clinic."],
      steps: [
        "Open Settings from the sidebar.",
        "Go to the Staff section.",
        "Add the new member, entering their name, role, and department.",
        "Complete the account creation. You can add their profile photo and documents now or later from their staff profile.",
      ],
      notes: [
        "Managers can create doctor, receptionist, or manager accounts, but cannot create an administrator account.",
        "A member's role determines what they can reach. Only the clinic's primary administrator can tune page-by-page visibility under Settings → Customize.",
      ],
      keywords: [
        "add staff",
        "new employee",
        "create user account",
        "invite doctor",
        "add receptionist",
        "hire",
        "add team member",
      ],
    },
    ar: {
      title: "إضافة موظف",
      summary: "إنشاء حساب موظف في العيادة. يمكن للمدير إضافة موظفين غير مسؤولين، ويمكن للمسؤول إضافة أي دور وظيفي مدعوم.",
      prerequisites: ["أن تكون مسؤولًا أو مديرًا في العيادة."],
      steps: [
        "افتح «الإعدادات» من القائمة الجانبية.",
        "انتقل إلى قسم «الموظفون».",
        "أضف العضو الجديد مع إدخال الاسم والدور والقسم.",
        "أكمل إنشاء الحساب. يمكنك إضافة صورته ومستنداته الآن أو لاحقًا من ملفه الوظيفي.",
      ],
      notes: [
        "يمكن للمدير إنشاء حساب طبيب أو موظف استقبال أو مدير، لكنه لا يستطيع إنشاء حساب مسؤول.",
        "يحدّد دور العضو ما يمكنه الوصول إليه. ولا يضبط رؤية كل صفحة من «الإعدادات ← التخصيص» إلا المسؤول الأساسي للعيادة.",
      ],
      keywords: [
        "إضافة موظف",
        "موظف جديد",
        "إنشاء حساب مستخدم",
        "إضافة طبيب",
        "إضافة موظف استقبال",
        "تعيين",
      ],
    },
  },
  {
    id: "control-page-visibility",
    navigationTarget: "settings_customize",
    roles: ["admin"],
    en: {
      title: "Show or hide pages for a staff member",
      summary:
        "Turn individual pages on or off for a specific user, within what their role already allows.",
      prerequisites: ["You are the clinic's administrator."],
      steps: [
        "Open Settings from the sidebar.",
        "Go to the Customize section.",
        "Select the staff member whose access you want to adjust.",
        "Toggle the pages that should be visible to them, then save.",
      ],
      notes: [
        "This narrows access; it can never widen it. A page the user's role does not include cannot be turned on here.",
        "The Dashboard is always visible and cannot be hidden.",
        "Hiding a page takes effect everywhere, including this assistant — it will stop offering that page to that user.",
      ],
      keywords: [
        "hide page",
        "show page",
        "page permissions",
        "restrict access",
        "customize sidebar",
        "user access",
        "remove access to revenue",
      ],
    },
    ar: {
      title: "إظهار الصفحات أو إخفاؤها لموظف",
      summary: "تفعيل أو تعطيل صفحات بعينها لمستخدم محدد، ضمن ما يسمح به دوره أصلًا.",
      prerequisites: ["أن تكون مسؤول العيادة."],
      steps: [
        "افتح «الإعدادات» من القائمة الجانبية.",
        "انتقل إلى قسم «التخصيص».",
        "اختر الموظف الذي تريد ضبط وصوله.",
        "فعّل أو عطّل الصفحات التي ينبغي أن يراها، ثم احفظ.",
      ],
      notes: [
        "هذا الضبط يضيّق الوصول ولا يوسّعه أبدًا؛ فالصفحة التي لا يشملها دور المستخدم لا يمكن تفعيلها هنا.",
        "لوحة التحكم ظاهرة دائمًا ولا يمكن إخفاؤها.",
        "يسري إخفاء الصفحة في كل مكان، بما في ذلك هذا المساعد — فلن يعرض تلك الصفحة على ذلك المستخدم.",
      ],
      keywords: [
        "إخفاء صفحة",
        "إظهار صفحة",
        "صلاحيات الصفحات",
        "تقييد الوصول",
        "تخصيص القائمة",
        "وصول المستخدم",
      ],
    },
  },
  {
    id: "manage-services-pricing",
    navigationTarget: "settings_services",
    roles: ADMIN_MANAGER,
    en: {
      title: "Set up services and prices",
      summary:
        "Define the treatments the clinic offers and what each one costs, so sessions can be invoiced.",
      prerequisites: ["At least one department exists."],
      steps: [
        "Open Settings from the sidebar.",
        "Go to the Services section.",
        "Choose Add service.",
        "Enter the service name, the department it belongs to, and its price, then save.",
      ],
      notes: [
        "Services are what appear when billing a session, so a missing service cannot be charged.",
        "Multi-session bundles are configured separately under Settings → Packages.",
      ],
      keywords: [
        "service price",
        "add service",
        "pricing",
        "change price",
        "treatment cost",
        "fees",
      ],
    },
    ar: {
      title: "إعداد الخدمات والأسعار",
      summary:
        "تعريف الخدمات التي تقدّمها العيادة وسعر كل منها، حتى يمكن إصدار فواتير الجلسات.",
      prerequisites: ["وجود قسم واحد على الأقل."],
      steps: [
        "افتح «الإعدادات» من القائمة الجانبية.",
        "انتقل إلى قسم «الخدمات».",
        "اختر «إضافة خدمة».",
        "أدخل اسم الخدمة والقسم التابعة له وسعرها، ثم احفظ.",
      ],
      notes: [
        "الخدمات هي ما يظهر عند محاسبة الجلسة، فالخدمة غير المعرّفة لا يمكن احتسابها.",
        "تُضبط باقات الجلسات المتعددة بشكل منفصل في «الإعدادات ← الباقات».",
      ],
      keywords: [
        "سعر الخدمة",
        "إضافة خدمة",
        "التسعير",
        "تغيير السعر",
        "تكلفة العلاج",
        "الرسوم",
      ],
    },
  },
  {
    id: "manage-departments",
    navigationTarget: "settings_departments",
    roles: ADMIN_MANAGER,
    en: {
      title: "Manage departments",
      summary:
        "Create the clinic's departments — the grouping that organizes staff, services, and reporting.",
      prerequisites: ["You are an administrator or a manager of the clinic."],
      steps: [
        "Open Settings from the sidebar.",
        "Go to the Departments section.",
        "Choose Add department and enter its name.",
        "Save. The department is now selectable for staff, services, and bookings.",
      ],
      notes: [
        "Departments drive much of the reporting breakdown, so naming them consistently pays off later.",
      ],
      keywords: [
        "department",
        "add department",
        "clinic sections",
        "specialties",
        "organize clinic",
      ],
    },
    ar: {
      title: "إدارة الأقسام",
      summary:
        "إنشاء أقسام العيادة — وهي التصنيف الذي ينظّم الموظفين والخدمات والتقارير.",
      prerequisites: ["أن تكون مسؤولًا أو مديرًا في العيادة."],
      steps: [
        "افتح «الإعدادات» من القائمة الجانبية.",
        "انتقل إلى قسم «الأقسام».",
        "اختر «إضافة قسم» وأدخل اسمه.",
        "احفظ. يصبح القسم متاحًا للاختيار للموظفين والخدمات والحجوزات.",
      ],
      notes: ["تعتمد كثير من تفصيلات التقارير على الأقسام، لذا فإن تسميتها باتساق مفيد لاحقًا."],
      keywords: [
        "قسم",
        "إضافة قسم",
        "أقسام العيادة",
        "التخصصات",
        "تنظيم العيادة",
      ],
    },
  },
  {
    id: "configure-working-hours",
    navigationTarget: "settings_clinic",
    roles: ADMIN_MANAGER,
    en: {
      title: "Set the clinic's working hours",
      summary:
        "Define which days the clinic is open and the shifts within each day. This is what determines bookable slots.",
      prerequisites: ["You are the clinic's administrator to save changes."],
      steps: [
        "Open Settings from the sidebar.",
        "Go to the Clinic section.",
        "Find Working hours.",
        "For each day, mark it open or closed and configure up to 2 shifts.",
        "Choose Save working hours.",
      ],
      notes: [
        "Managers can view the clinic settings but only an administrator can change them.",
        "The clinic's logo, display currency, and time format are configured on the same page.",
      ],
      keywords: [
        "working hours",
        "opening hours",
        "clinic schedule",
        "shifts",
        "close on friday",
        "clinic logo",
        "currency",
      ],
    },
    ar: {
      title: "ضبط ساعات عمل العيادة",
      summary:
        "تحديد أيام عمل العيادة والورديات في كل يوم. هذا ما يحدّد الأوقات المتاحة للحجز.",
      prerequisites: ["أن تكون مسؤول العيادة لحفظ التغييرات."],
      steps: [
        "افتح «الإعدادات» من القائمة الجانبية.",
        "انتقل إلى قسم «العيادة».",
        "ابحث عن «ساعات العمل».",
        "حدّد لكل يوم ما إذا كان مفتوحًا أو مغلقًا، واضبط حتى ورديتين.",
        "اختر «حفظ ساعات العمل».",
      ],
      notes: [
        "يمكن للمدير عرض إعدادات العيادة، لكن التعديل متاح للمسؤول فقط.",
        "يُضبط شعار العيادة وعملة العرض وصيغة الوقت في الصفحة نفسها.",
      ],
      keywords: [
        "ساعات العمل",
        "أوقات الدوام",
        "جدول العيادة",
        "الورديات",
        "شعار العيادة",
        "العملة",
      ],
    },
  },
  {
    id: "review-revenue",
    navigationTarget: "revenue",
    roles: ADMIN_MANAGER,
    en: {
      title: "Review revenue for a period",
      summary:
        "See what the clinic collected in a date range, broken down by payment method, with outstanding balances shown separately.",
      prerequisites: ["You are an administrator or a manager of the clinic."],
      steps: [
        "Open Revenue from the sidebar.",
        "Set the From and To dates for the period you want, then choose Apply.",
        "Review the total revenue and the breakdown by payment method.",
        "Use Print statement if you need a copy of the statement.",
      ],
      notes: [
        "The statement reflects completed appointments recorded within the period. Outstanding balances remain due and are not counted in collected revenue.",
        "Settlement payments — amounts collected against balances from earlier sessions — are listed separately.",
        "Receptionists do not have access to the Revenue page.",
      ],
      keywords: [
        "revenue",
        "income this month",
        "how much did we collect",
        "financial statement",
        "payments received",
        "earnings",
      ],
    },
    ar: {
      title: "مراجعة الإيرادات خلال فترة",
      summary:
        "الاطلاع على ما حصّلته العيادة خلال فترة زمنية، موزّعًا حسب طريقة الدفع، مع عرض المبالغ المستحقة منفصلة.",
      prerequisites: ["أن تكون مسؤولًا أو مديرًا في العيادة."],
      steps: [
        "افتح «الإيرادات» من القائمة الجانبية.",
        "حدّد تاريخي «من» و«إلى» للفترة المطلوبة ثم اختر «تطبيق».",
        "راجع إجمالي الإيرادات والتوزيع حسب طريقة الدفع.",
        "استخدم «طباعة الكشف» إذا احتجت نسخة من كشف الحساب.",
      ],
      notes: [
        "يعكس الكشف المواعيد المكتملة المسجَّلة خلال الفترة. وتبقى المبالغ المستحقة قائمة ولا تُحتسب ضمن المحصَّل.",
        "تُعرض دفعات التسوية — المبالغ المحصَّلة مقابل أرصدة جلسات سابقة — بشكل منفصل.",
        "لا يملك موظفو الاستقبال صلاحية الوصول إلى صفحة الإيرادات.",
      ],
      keywords: [
        "الإيرادات",
        "دخل هذا الشهر",
        "كم حصّلنا",
        "كشف مالي",
        "المدفوعات المستلمة",
      ],
    },
  },
  {
    id: "run-clinic-report",
    navigationTarget: "reports_index",
    roles: ADMIN_MANAGER_RECEPTION,
    en: {
      title: "Run a clinic report",
      summary:
        "Open one of the clinic's standard reports for a chosen period: cancellations, no-shows, revenue, follow-ups, doctor performance, or receptionist performance.",
      prerequisites: [],
      steps: [
        "Open Reports from the sidebar.",
        "Choose the report you need.",
        "Set the period you want to cover.",
        "Review the results, and print them if you need a copy.",
      ],
      notes: [
        "Which reports you see depends on your role — doctor and receptionist performance reports are for administrators and managers.",
        "You can also ask this assistant to run one of these reports and give you the link to the full report page.",
      ],
      keywords: [
        "run report",
        "reports",
        "cancellation report",
        "no show report",
        "doctor performance",
        "statistics",
        "monthly report",
      ],
    },
    ar: {
      title: "تشغيل تقرير للعيادة",
      summary:
        "فتح أحد تقارير العيادة القياسية لفترة محددة: الإلغاءات، عدم الحضور، الإيرادات، المتابعات، أداء الأطباء، أو أداء موظفي الاستقبال.",
      prerequisites: [],
      steps: [
        "افتح «التقارير» من القائمة الجانبية.",
        "اختر التقرير المطلوب.",
        "حدّد الفترة الزمنية المراد تغطيتها.",
        "راجع النتائج، واطبعها إذا احتجت نسخة.",
      ],
      notes: [
        "تعتمد التقارير المتاحة لك على دورك — فتقارير أداء الأطباء وموظفي الاستقبال مخصّصة للمسؤولين والمديرين.",
        "يمكنك أيضًا أن تطلب من هذا المساعد تشغيل أحد هذه التقارير وإعطاءك رابط صفحة التقرير الكاملة.",
      ],
      keywords: [
        "تشغيل تقرير",
        "التقارير",
        "تقرير الإلغاءات",
        "تقرير عدم الحضور",
        "أداء الأطباء",
        "الإحصائيات",
        "تقرير شهري",
      ],
    },
  },
  {
    id: "manage-ai-settings",
    navigationTarget: "settings_ai",
    roles: ["admin"],
    en: {
      title: "Manage assistant settings and access",
      summary:
        "Review the clinic's AI usage and control which staff members may ask the assistant financial questions.",
      prerequisites: [
        "You are the clinic's administrator.",
        "The clinic's plan includes the assistant.",
      ],
      steps: [
        "Open Settings from the sidebar.",
        "Go to the AI section.",
        "Review the clinic's assistant usage for the current period.",
        "Grant or revoke the financial insights permission for individual staff members, then save.",
      ],
      notes: [
        "The financial permission is per user and is separate from the plan: a manager needs both the plan feature and this grant before the assistant will answer revenue questions for them.",
        "Turning the grant off takes effect on the user's next question.",
      ],
      keywords: [
        "ai settings",
        "assistant settings",
        "financial insights permission",
        "who can ask about revenue",
        "ai usage",
        "assistant limit",
      ],
    },
    ar: {
      title: "إدارة إعدادات المساعد وصلاحياته",
      summary:
        "مراجعة استهلاك العيادة للذكاء الاصطناعي والتحكم في الموظفين المسموح لهم بسؤال المساعد أسئلة مالية.",
      prerequisites: [
        "أن تكون مسؤول العيادة.",
        "أن تشمل باقة العيادة المساعد.",
      ],
      steps: [
        "افتح «الإعدادات» من القائمة الجانبية.",
        "انتقل إلى قسم «الذكاء الاصطناعي».",
        "راجع استهلاك العيادة للمساعد في الفترة الحالية.",
        "امنح صلاحية «المؤشرات المالية» أو اسحبها لموظفين بعينهم، ثم احفظ.",
      ],
      notes: [
        "الصلاحية المالية فردية ومنفصلة عن الباقة: يحتاج المدير إلى ميزة الباقة وإلى هذا المنح معًا قبل أن يجيبه المساعد عن أسئلة الإيرادات.",
        "يسري إلغاء المنح اعتبارًا من السؤال التالي للمستخدم.",
      ],
      keywords: [
        "إعدادات الذكاء الاصطناعي",
        "إعدادات المساعد",
        "صلاحية المؤشرات المالية",
        "من يسأل عن الإيرادات",
        "استهلاك المساعد",
      ],
    },
  },
  {
    id: "customize-assistant-placement",
    navigationTarget: "settings_assistant",
    roles: ["admin"],
    requiredFeatures: [AI_ASSISTANT_CUSTOMIZATION_FEATURE],
    en: {
      title: "Customize where Ask assistant appears",
      summary:
        "Choose which eligible product areas show a contextual Ask assistant button for each role or individual staff member.",
      prerequisites: [
        "You are the clinic's primary administrator.",
        "The clinic's plan includes Assistant customization.",
      ],
      steps: [
        "Open Settings from the sidebar and go to Assistant placement.",
        "Under Role defaults, use the area-by-role matrix to show or hide an eligible launcher for that role.",
        "Choose People to select an active staff member and set an individual override when needed.",
        "Use Reset or Use role setting to remove an explicit choice and return to the inherited product or role default.",
      ],
      notes: [
        "Launcher placement changes visibility only. It never grants page, patient, financial, Assistant, or tool access.",
        "A personal override takes precedence over the role setting. Unsupported area and role combinations are not offered.",
      ],
      keywords: [
        "assistant placement",
        "show ask assistant button",
        "hide assistant launcher",
        "assistant by role",
        "assistant per user",
        "customize assistant",
      ],
    },
    ar: {
      title: "تخصيص مواضع زر «اسأل المساعد»",
      summary:
        "اختيار مناطق المنتج المؤهلة التي يظهر فيها زر «اسأل المساعد» السياقي حسب الدور أو حسب موظف بعينه.",
      prerequisites: [
        "أن تكون مسؤول العيادة الأساسي.",
        "أن تشمل خطة العيادة تخصيص المساعد.",
      ],
      steps: [
        "افتح «الإعدادات» من القائمة الجانبية وانتقل إلى «مواضع المساعد».",
        "ضمن «إعدادات الأدوار»، استخدم مصفوفة المناطق والأدوار لإظهار زر مؤهل لذلك الدور أو إخفائه.",
        "انتقل إلى «الأفراد» واختر موظفًا نشطًا لإضافة تجاوز فردي عند الحاجة.",
        "استخدم «إعادة الضبط» أو «استخدام إعداد الدور» لإزالة الخيار الصريح والعودة إلى الإعداد الافتراضي الموروث.",
      ],
      notes: [
        "تغيّر مواضع الزر الظهور فقط، ولا تمنح صلاحية للصفحات أو المرضى أو البيانات المالية أو المساعد أو الأدوات.",
        "يتقدم التجاوز الفردي على إعداد الدور، ولا تظهر التركيبات غير المدعومة بين المنطقة والدور.",
      ],
      keywords: [
        "مواضع المساعد",
        "إظهار زر اسأل المساعد",
        "إخفاء زر المساعد",
        "المساعد حسب الدور",
        "تخصيص المساعد للموظف",
      ],
    },
  },
  {
    id: "ask-assistant-financial",
    navigationTarget: "assistant",
    roles: ADMIN_MANAGER,
    requiredFeatures: [AI_FINANCIAL_INSIGHTS_FEATURE],
    requiredUserPermission: "ai.financial_insights",
    en: {
      title: "Ask the assistant about revenue and outstanding balances",
      summary:
        "Use the assistant for financial questions: revenue for a period, a comparison between two periods, or the largest outstanding patient balances.",
      prerequisites: [
        "Managers need the per-user financial insights grant; administrators have this permission implicitly.",
      ],
      steps: [
        "Open Assistant from the sidebar.",
        "Ask your question in plain Arabic or English — for example, revenue for last month compared with the month before.",
        "Follow the report link in the answer to verify any figure against the full report page.",
      ],
      notes: [
        "Every figure comes from your clinic's own records; the assistant never estimates a number it could not read.",
        "The assistant is read-only and never changes financial records.",
      ],
      keywords: [
        "ask about revenue",
        "assistant financial",
        "outstanding balances",
        "compare revenue",
        "ai revenue question",
      ],
    },
    ar: {
      title: "سؤال المساعد عن الإيرادات والمبالغ المستحقة",
      summary:
        "استخدام المساعد في الأسئلة المالية: إيرادات فترة، أو مقارنة بين فترتين، أو أكبر المبالغ المستحقة على المرضى.",
      prerequisites: [
        "يحتاج المدير إلى منحة «المؤشرات المالية» الفردية؛ أما المسؤول فتكون هذه الصلاحية ضمنية لديه.",
      ],
      steps: [
        "افتح «المساعد» من القائمة الجانبية.",
        "اطرح سؤالك بلغة عادية بالعربية أو الإنجليزية — مثل إيرادات الشهر الماضي مقارنة بالشهر السابق له.",
        "اتبع رابط التقرير في الإجابة للتحقق من أي رقم في صفحة التقرير الكاملة.",
      ],
      notes: [
        "كل رقم مصدره سجلات عيادتك؛ ولا يقدّر المساعد أبدًا رقمًا لم يستطع قراءته.",
        "المساعد للقراءة فقط ولا يعدّل السجلات المالية.",
      ],
      keywords: [
        "السؤال عن الإيرادات",
        "المساعد المالي",
        "المبالغ المستحقة",
        "مقارنة الإيرادات",
      ],
    },
  },
  {
    id: "use-the-assistant",
    navigationTarget: "assistant",
    roles: ALL_STAFF,
    en: {
      title: "Use the ClinicFlow assistant",
      summary:
        "Ask about your clinic in plain Arabic or English and get answers drawn from your own clinic's records.",
      prerequisites: [],
      steps: [
        "Open Assistant from the sidebar.",
        "Type your question in Arabic or English.",
        "Read the answer, and follow any link it gives you to see the full record or report.",
      ],
      notes: [
        "The assistant is read-only. It never books, edits, cancels, or deletes anything.",
        "It can only see what your role and permissions allow — it is not a way around an access restriction.",
        "If it cannot answer something from your clinic's data, it says so rather than guessing.",
      ],
      keywords: [
        "assistant",
        "how to use the assistant",
        "ai",
        "what can the assistant do",
        "ask a question",
        "chatbot",
      ],
    },
    ar: {
      title: "استخدام مساعد كلينيك فلو",
      summary:
        "اطرح أسئلتك عن العيادة بالعربية أو الإنجليزية واحصل على إجابات مستمدة من سجلات عيادتك.",
      prerequisites: [],
      steps: [
        "افتح «المساعد» من القائمة الجانبية.",
        "اكتب سؤالك بالعربية أو الإنجليزية.",
        "اقرأ الإجابة، واتبع أي رابط تقدّمه لعرض السجل أو التقرير الكامل.",
      ],
      notes: [
        "المساعد للقراءة فقط، ولا يحجز ولا يعدّل ولا يلغي ولا يحذف شيئًا.",
        "لا يرى إلا ما يسمح به دورك وصلاحياتك — وليس وسيلة لتجاوز أي قيد وصول.",
        "وإذا تعذّر عليه الإجابة من بيانات عيادتك، فإنه يصرّح بذلك بدل التخمين.",
      ],
      keywords: [
        "المساعد",
        "كيف أستخدم المساعد",
        "الذكاء الاصطناعي",
        "ماذا يستطيع المساعد",
        "طرح سؤال",
      ],
    },
  },
  {
    id: "change-language-and-theme",
    navigationTarget: "preferences",
    roles: ALL_STAFF,
    en: {
      title: "Change your language or appearance",
      summary: "Switch ClinicFlow between Arabic and English, or change the theme.",
      prerequisites: [],
      steps: [
        "Open Preferences from your account menu.",
        "Choose your language and appearance.",
        "The change applies to your own account only.",
      ],
      notes: [
        "Switching to Arabic also switches the interface to right-to-left layout.",
      ],
      keywords: [
        "change language",
        "arabic",
        "english",
        "dark mode",
        "theme",
        "appearance",
      ],
    },
    ar: {
      title: "تغيير اللغة أو المظهر",
      summary: "التبديل بين العربية والإنجليزية في كلينيك فلو، أو تغيير المظهر.",
      prerequisites: [],
      steps: [
        "افتح «التفضيلات» من قائمة حسابك.",
        "اختر اللغة والمظهر.",
        "ينطبق التغيير على حسابك أنت فقط.",
      ],
      notes: ["التبديل إلى العربية يحوّل الواجهة أيضًا إلى الاتجاه من اليمين إلى اليسار."],
      keywords: [
        "تغيير اللغة",
        "العربية",
        "الإنجليزية",
        "الوضع الداكن",
        "المظهر",
      ],
    },
  },
];

export const HELP_ARTICLES_BY_ID = new Map(
  HELP_ARTICLES.map((article) => [article.id, article]),
);
