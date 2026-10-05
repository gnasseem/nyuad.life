/**
 * Screening for what students write: questions to Ask, and everything posted to the board (questions, answers,
 * notices, listings, offers, names). Rules only, so it costs nothing and adds no delay. It is tuned to let ordinary
 * student talk through ("this course killed me", "weed-out class", "past exams for MATH 1012?") and stop what should
 * not be on a campus site in the UAE: slurs and threats, drugs and other illegal sales, paid academic work, scams and
 * phishing, other people's personal data, and attempts to steer the answer model. Someone who writes about hurting
 * themselves is not blocked but answered with where to get help.
 */

export type ScreenReason = 'abuse' | 'sexual' | 'prohibited' | 'academic' | 'scam' | 'phishing' | 'personal_data' | 'contact' | 'manipulation' | 'spam' | 'self_harm';

export interface Screened {
  reason: ScreenReason;
  /** Written for the student: what is wrong and, where it helps, what to do instead. */
  message: string;
}

/** What is being screened decides what is allowed: a phone number is fine on a notice, not in a public answer. */
export type PostKind = 'question' | 'answer' | 'notice' | 'listing' | 'offer' | 'name';

export const SUPPORT_MESSAGE =
  "It sounds like you're going through something really hard, and you don't have to deal with it alone. You can talk to someone right now:\n\n" +
  '- **NYU Wellness Exchange**, 24/7, free and confidential: call **+1 (212) 443-9999** or use the chat in the NYU Mobile app.\n' +
  '- **NYUAD Health and Wellness (Counseling)** on campus, for an appointment with a counselor.\n' +
  '- In an emergency in the UAE, call **999** (police) or **998** (ambulance).\n\n' +
  'If a friend wrote this, reach out to them and to one of the services above.';

/** Lower-cased, accents and look-alike characters folded, leetspeak undone, runs of one letter squeezed. */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[0134578@$]/g, (char) => ({ '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's' })[char] ?? char)
    .replace(/[’'`]/g, '')
    .replace(/([a-z])\1{2,}/g, '$1$1');
}

/** Words only, one space apart: "k.i.l.l y-o-u" stays readable to the patterns below. */
function words(text: string): string {
  return ` ${normalize(text).replace(/[^a-z؀-ۿ]+/g, ' ').trim()} `;
}

// Slurs, matched as whole words after folding. Kept short on purpose: the ones that are never anything else.
const SLURS = /\s(?:n[i!]gg(?:a|as|er|ers|ah)|f[a]gg?(?:ot|ots|y)|r[e]tard(?:s|ed)?|k[i]ke(?:s)?|sp[i]c(?:s)?|ch[i]nk(?:s)?|tr[a]nn(?:y|ies)|wetback(?:s)?|raghead(?:s)?|towelhead(?:s)?|sandn[i]gg(?:er|ers))\s/;
const THREATS = /\s(?:kys|kill (?:your ?self|urself|yo self)|(?:i ?ll|i will|im gonna|im going to|gonna|going to) (?:kill|hurt|stab|shoot|beat|rape|find) (?:you|u|him|her|them|ur)|(?:you|u) (?:should|deserve to) die|hope (?:you|u) die)\s/;
const SEXUAL = /\s(?:escorts?|sugar (?:daddy|baby|mommy)|nudes?|onlyfans|only fans|hook ?ups?|sex (?:work|services?)|happy ending|massage with extras)\s/;

// What may not be sold or arranged here: illegal in the UAE, or against campus rules.
const DRUGS = /\s(?:weed(?! out)|cannabis|marijuana|thc|cbd|hashish|cocaine|coke bags?|mdma|ecstasy|lsd|acid tabs?|shrooms|magic mushrooms|ketamine|heroin|meth|crystal meth|xanax|adderall|ritalin|vyvanse|modafinil|tramadol|oxycodone|oxycontin|percocet|codeine|edibles)\s/;
// Alcohol and nicotine are legal for adults in the UAE, so asking about them is fine; selling them between students
// is not. Glassware, glue guns and the like are ordinary listings.
const OTHER_GOODS = /\s(?:alcohol|vodka|whiskey|whisky|beers?(?! (?:pong|glass|glasses|mug|mugs))|wine(?! (?:glass|glasses|opener|rack|cooler))|tequila|liquor|booze|vapes?|vaping|juul|elf bar|e ?cigs?|e ?cigarettes?|cigarettes?|cigs|nicotine|zyn|(?<!(?:glue|heat|nerf|massage|water|toy|staple|nail) )guns?|pistols?|rifles?|ammo|ammunition|tasers?|stun guns?|pepper spray|knuckle dusters?|fake (?:ids?|passports?|degrees?|certificates?)|counterfeit|forged (?:documents?|papers?|ids?))\s/;
const SELLING = /\s(?:sell(?:s|ing)?|for sale|wts|buy(?:ing)?|wtb|selling|order(?:ing)?|deliver(?:y|ing)?|plug|dealer|supplier|in stock|dm (?:me )?(?:for|to)|price|aed|dhs|dirhams?)\s/;
const ACQUIRE = /\s(?:where (?:can|do|to) (?:i |we )?(?:buy|get|find|score|cop)|(?:buy|get|find|score|cop|smoke|order) (?:some )?|anyone (?:have|has|selling|got)|plug for|dealer)\s/;

// Paid academic work: the help itself is fine, buying or selling it is not.
const ACADEMIC_TASK = '(?:essays?|papers?|assignments?|homework|hw|problem sets?|psets?|exams?|quiz(?:zes)?|tests?|midterms?|finals?|capstone|thesis|lab reports?|projects?|coursework|online class(?:es)?)';
/** Someone offering to do the work, or someone paying for it; "help me do my homework" is neither. */
const ACADEMIC_OFFER = new RegExp(`\\s(?:i (?:will|can|ll|ill|could) (?:write|do|take|complete|finish|solve) (?:your|ur|any|all your) ${ACADEMIC_TASK}|(?:pay|paid|hire|hiring) (?:someone|somebody|anyone|you|a tutor|a person) (?:to )?(?:write|do|take|complete|finish)|${ACADEMIC_TASK} (?:writing|solving) services?|(?:leaked|stolen) (?:exams?|midterms?|finals?|quiz(?:zes)?|answers?|answer keys?))\\s`);
const ACADEMIC_TASK_DONE = new RegExp(`\\s(?:write|do|take|complete|finish|solve) (?:my|your|ur|someones?) ${ACADEMIC_TASK}\\s`);
const PAYMENT = /\s(?:pay|paid|payment|money|cash|aed|dhs|dirhams?|usd|price|rate|venmo|fee|will pay|for (?:money|cash))\s/;

function academicService(text: string): boolean {
  return ACADEMIC_OFFER.test(text) || (ACADEMIC_TASK_DONE.test(text) && PAYMENT.test(text));
}

// Money schemes, and attempts to get credentials.
const SCAM = /\s(?:guaranteed (?:returns?|profits?|income)|double your money|passive income|crypto (?:signals?|investment|trading group)|forex (?:signals?|trading group)|investment opportunity|binary options|get rich quick|easy money|work from home and earn|(?:pay|send|buy) (?:me |us )?(?:in |with )?(?:itunes |google play |amazon |steam |apple )?gift cards?|western union|moneygram|pyramid scheme|mlm|send (?:me )?(?:the )?(?:money|payment|deposit) first)\s/;
const PHISHING = /\s(?:(?:send|share|enter|give|tell|dm|confirm) (?:me |us )?(?:your )?(?:password|passcode|pin|otp|one time (?:password|code)|verification code|2fa code|login details|credentials)|verify your (?:netid|nyu|account|identity|login|email)|(?:your )?(?:netid|nyu (?:account|email)) (?:will be|has been) (?:suspended|locked|deactivated|disabled))\s/;
/** Text written to steer the answer model rather than to inform students. */
const MANIPULATION = /\s(?:ignore (?:all |any |the |your )?(?:previous|prior|above|earlier|other) (?:instructions|prompts?|rules|sources)|disregard (?:the |your |all )?(?:previous|prior|above|system) (?:instructions|prompts?)|system (?:note|prompt|instruction)s?|you are now (?:an? )?(?:ai|assistant|chatbot|dan|unfiltered|unrestricted)|reveal (?:your|the) (?:system )?(?:prompt|instructions)|(?:assistant|ai|model) must (?:tell|say|answer|reply))\s/;
// Hyperbole ("this exam makes me want to die") is everywhere in student talk, so only clear statements count.
const SELF_HARM = /\s(?:kill (?:my ?self|myself)|end (?:my|it) (?:life|all)|end it all|suicid(?:e|al)|self ?harm(?:ing)?|cut(?:ting)? myself|dont want to (?:live|be alive) anymore|no reason to live|better off dead|take my (?:own )?life)\s/;

/** Looking a person up: their WhatsApp, Instagram, room or home. Offices' numbers are fine to ask for. */
const PERSONAL_FIELD = '(?:whatsapp|instagram|insta|snapchat|snap|room number|dorm room|home address|personal (?:number|phone|email))';
const DOXXING = new RegExp(`\\s(?:${PERSONAL_FIELD} (?:of|for) (?!the |a |an )[a-z]+|(?:what is|whats|find|get|give me|anyone (?:have|has|know)|does anyone (?:have|know)) [a-z]+(?: [a-z]+)?s ${PERSONAL_FIELD}|where does (?!a |an |the |one |everyone |everybody |someone |anyone )[a-z]+(?: [a-z]+)? live|which (?:room|apartment) (?:does|is) [a-z]+ (?:in|live))\\s`);

const PHONE = /(?:\+|\b00)\s?\d{1,3}[\s-]?\(?\d{1,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}|\b05\d[\s-]?\d{3}[\s-]?\d{4}\b/;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** An office's address ("nyuad.registrar@nyu.edu") is fine to share; a person's NetID address or a gmail is not. */
function hasPersonalEmail(text: string): boolean {
  return (text.match(EMAIL) ?? []).some((email) => !/@(?:[\w-]+\.)*nyu\.edu$/i.test(email) || /^[a-z]{2,4}\d{2,6}@/i.test(email));
}
const EMIRATES_ID = /\b784[\s-]?\d{4}[\s-]?\d{7}[\s-]?\d\b/;
const IBAN = /\bAE\d{2}\s?(?:\d{4}\s?){4}\d{3}\b/i;
const LINK = /\bhttps?:\/\/[^\s)]+|\bwww\.[^\s)]+/gi;

/** Card numbers pass the Luhn check; most other long digit runs (class numbers, dates) do not. */
function hasCardNumber(text: string): boolean {
  for (const match of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = match[0].replace(/\D/g, '');
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let digit = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
      sum += digit;
    }
    if (sum % 10 === 0 && /^[3-6]/.test(digits)) return true;
  }
  return false;
}

/**
 * A sign-in page dressed up as NYU's: a host that borrows "nyu" without being nyu.edu, and asks to log in or verify
 * ("nyu-verify.com", "nyuad-login.net/sso"). Student clubs' own sites with "nyu" in the name are left alone.
 */
function hasLookalikeLink(text: string): boolean {
  for (const link of text.match(LINK) ?? []) {
    let url: URL;
    try {
      url = new URL(link.startsWith('http') ? link : `https://${link}`);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase();
    if (/nyu/.test(host) && !/(?:^|\.)nyu\.edu$/.test(host) && /login|log-in|signin|sign-in|verify|secure|account|auth|sso|password|portal|update/i.test(host + url.pathname)) return true;
  }
  return false;
}

const MESSAGES: Record<Exclude<ScreenReason, 'self_harm'>, string> = {
  abuse: 'This has language that targets or threatens people. Rephrase it without that to post.',
  sexual: 'Sexual content and services are not allowed here.',
  prohibited: 'Selling or arranging drugs, alcohol, prescription medicine, vapes, weapons or fake documents is not allowed here: it is against campus rules and UAE law.',
  academic: 'Buying or selling academic work, or exam answers, is against NYU’s academic integrity policy. Asking for help or study advice is fine.',
  scam: 'This reads like a money scheme, which is not allowed here.',
  phishing: 'Never ask people for passwords, codes or to "verify" their NYU account. Posts like this are blocked.',
  personal_data: 'Remove the ID, card or bank number before posting. Never share these publicly.',
  contact: 'Remove the phone number or email from the text. On listings and offers, put it in the contact field, which is only shown one post at a time.',
  manipulation: 'This looks written to steer the answer bot rather than to inform students, so it cannot be posted.',
  spam: 'Too many links. Keep it to one or two.',
};

/**
 * Screens something a student wants to post. Null when it can be posted; otherwise why not. Self-harm is reported
 * with SUPPORT_MESSAGE so the student gets help instead of a refusal.
 */
export function screenPost(kind: PostKind, ...parts: Array<string | null | undefined>): Screened | null {
  const raw = parts.filter(Boolean).join('\n');
  if (!raw.trim()) return null;
  const text = words(raw);
  const block = (reason: Exclude<ScreenReason, 'self_harm'>): Screened => ({ reason, message: MESSAGES[reason] });

  if (SLURS.test(text) || THREATS.test(text)) return block('abuse');
  if (kind !== 'name' && SELF_HARM.test(text)) return { reason: 'self_harm', message: SUPPORT_MESSAGE };
  if (SEXUAL.test(text)) return block('sexual');
  if (PHISHING.test(text) || hasLookalikeLink(raw)) return block('phishing');
  if (MANIPULATION.test(text)) return block('manipulation');
  if (EMIRATES_ID.test(raw) || IBAN.test(raw) || hasCardNumber(raw)) return block('personal_data');
  if (academicService(text)) return block('academic');
  if (SCAM.test(text)) return block('scam');
  // Anything for sale is screened for what is being sold; elsewhere only asking where to get it counts.
  const selling = kind === 'listing' || kind === 'offer' || SELLING.test(text);
  if ((selling || ACQUIRE.test(text)) && (DRUGS.test(text) || (kind !== 'question' && OTHER_GOODS.test(text)))) return block('prohibited');
  if ((kind === 'question' || kind === 'answer' || kind === 'listing' || kind === 'offer') && (PHONE.test(raw) || hasPersonalEmail(raw))) return block('contact');
  if ((raw.match(LINK)?.length ?? 0) > 3) return block('spam');
  return null;
}

export interface AskScreen {
  /** The reply to show instead of an answer. */
  reply: string;
  reason: ScreenReason;
}

/**
 * Screens a question to Ask. Most questions pass; the ones that do not get a short reply instead of an answer, and
 * no model call is spent on them. Asking about rules ("can I bring my ADHD medication into the UAE?") is fine;
 * asking where to buy drugs is not.
 */
export function screenAsk(question: string): AskScreen | null {
  const text = words(question);
  if (SELF_HARM.test(text)) return { reason: 'self_harm', reply: SUPPORT_MESSAGE };
  if (SLURS.test(text) || THREATS.test(text)) return { reason: 'abuse', reply: "I can't help with that. Ask me anything about life at NYUAD." };
  if (MANIPULATION.test(text)) return { reason: 'manipulation', reply: 'I only answer questions about NYUAD, from the group, official pages and the class schedule. What would you like to know?' };
  if (DOXXING.test(text)) return { reason: 'personal_data', reply: "I can't help find someone's number, room or where they live. If you need to reach a student, ask in the group or through their NYU email." };
  if (academicService(text)) return { reason: 'academic', reply: MESSAGES.academic };
  if (SEXUAL.test(text)) return { reason: 'sexual', reply: "I can't help with that. Ask me anything about life at NYUAD." };
  if (ACQUIRE.test(text) && DRUGS.test(text)) return { reason: 'prohibited', reply: "I can't help with getting drugs or prescription medicine without a prescription. The UAE has very strict drug laws, including for some medicines that are legal elsewhere. If you have a prescription, ask how to bring or fill it here, and the Health Center can help." };
  return null;
}
