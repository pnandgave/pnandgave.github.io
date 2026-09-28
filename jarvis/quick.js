/* Quick commands, understood in code with no model at all (instant, works offline). Same rules as the laptop Hub's quick.py.
   Only clear phrasings are handled here; anything else returns null and goes to Gemini.
     brief:     "brief me", "what's my day", "what's next", "my plan for today", "evening review" ...
     add_task:  "remind me to ...", "add task ...", "task: ...", "todo: ...", "schedule ...", "add ... to my PhD list"
   Dates and times are only cut out of the title here; the real date is worked out by JDates. */
(function (root) {
  const WD = 'monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun';
  const MO = 'january|february|march|april|june|july|august|september|october|november|december|sept|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
  const BRIEF = new RegExp("^(brief( me)?|(give me |read me )?(my |the |today'?s? )?(brief|briefing|morning brief|evening (brief|review)|daily brief)" +
    "|(what'?s|what is|whats) (my day|my plan|my schedule|next|up next|on today|on my plate|on the agenda|today)( today| like)?" +
    "|what do i have( on)?( today)?|how (does|is) my day( look| looking)?( like)?|my (day|plan|schedule|agenda)( today| for today)?" +
    "|plan (for )?(my |the )?day|(today'?s |my )?agenda)$");
  const ADD = new RegExp("^(?:remind me (?:to|about)|add (?:a )?(?:task|todo|to-?do|reminder)(?: to| for| about)?:?|new task:?|task:|todo:|to-?do:" +
    "|put (?:a )?(?:task|reminder)(?: to)?:?|schedule|don'?t let me forget to)\\s+(.+)$", 'i');
  const LIST_RX = '(phd|college|health|brand(?: (?:&|and) career)?|career|learning|freelance|books?|inbox)';
  const ADD_TO = new RegExp(`^(?:add|put)\\s+(.+?)\\s+(?:to|in|on|into|under)\\s+(?:my\\s+|the\\s+)?${LIST_RX}(?:\\s+list)?(\\s+.*)?$`, 'i');
  const END_LIST = new RegExp(`\\s+(?:to|in|on|into|under)\\s+(?:my\\s+|the\\s+)?${LIST_RX}(?:\\s+list)?\\s*$`, 'i');
  const DURATION = /\bfor\s+(?:(\d+)\s*(minutes?|mins?|m|hours?|hrs?|h)|(an?|one|half an?)\s+(hour|hr))\b/i;
  const TIME = /(?:\b(?:at|by|around)\s+)?(?:\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\b(?:noon|midday)\b)|\bat\s+\d{1,2}\b(?!\s*(?:\/|st|nd|rd|th|\d))/i;
  const DATE = new RegExp('(?:\\b(?:on|by|before|due|until|for)\\s+)?(?:' +
    '\\bday after tomorrow\\b|\\b(?:tomorrow|tmrw|tmr|today|tonight)\\b|\\bthis (?:evening|morning|afternoon)\\b' +
    '|\\bin (?:\\d+|a|one|two|three) (?:days?|weeks?)\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?\\b' +
    `|\\b\\d{1,2}(?:st|nd|rd|th)? (?:of )?(?:${MO})\\b(?: \\d{4})?|\\b(?:${MO}) \\d{1,2}(?:st|nd|rd|th)?\\b(?: \\d{4})?` +
    `|\\bnext week\\b|\\bend of (?:the )?week\\b|\\beow\\b|\\b(?:this )?weekend\\b|\\b(?:(?:this|next|coming) )?(?:${WD})\\b)`, 'i');
  const P1 = /\b(urgent(ly)?|asap|high priority|top priority|p1|it'?s important|important)\b/gi;
  const P3 = /\b(low priority|optional(ly)?|p3|someday|if (i get|there is) time)\b/gi;
  /* words that point to a workstream; the list with most hits wins, ties go to the earlier list */
  const KEYWORDS = {
    'PhD': 'phd|ph\\.d|thesis|viva|supervisor|mathapati|specimens?|tensile|flexural|charpy|impact test|tribolog\\w*|wear test|erosion' +
           '|graphene|petg|nylon|pa12|taguchi|anova|l27|astm|journal|manuscript|vtu|raman|instron|filament|research paper|review paper',
    'Freelance': 'client|customer|invoice|quotation|quote|freelance|millennium|order|estimate|estimation|imperial',
    'Books': 'book|chapter|publisher|book outline',
    'College': 'college|lecture|class|classes|students?|hod|exam|exams|department|naac|nba|syllabus|attendance|marks|timetable' +
               '|internals?|practicals?|robotics (club|cell)|faculty|principal|dypcet|lab manual|question paper',
    'Health': 'gym|workout|exercise|walk|running|run|yoga|doctor|dentist|check-?up|diet|sleep|steps|swim',
    'Brand & career': 'linkedin|portfolio|github|resume|cv|personal brand|website|profile|post',
    'Learning': 'course|learn|learning|tutorial|udemy|coursera|nptel|study|practise|practice|certification',
  };
  const LIST_NAMES = {phd: 'PhD', college: 'College', health: 'Health', brand: 'Brand & career', 'brand & career': 'Brand & career',
    'brand and career': 'Brand & career', career: 'Brand & career', learning: 'Learning', freelance: 'Freelance', book: 'Books', books: 'Books', inbox: 'Inbox'};

  function norm(text) {                         // tidy the words but keep his capitals (for the task title)
    let t = String(text).replace(/’/g, "'").replace(/\s+/g, ' ').trim();
    t = t.replace(/^(hey |ok |okay )?jarvis[,:]?\s*/i, '').replace(/^(please|pls|can you|could you)\s+/i, '').replace(/\s+(please|pls)[?.!]*$/i, '');
    return t.replace(/^[\s?.!]+|[\s?.!]+$/g, '');
  }
  function cut(rx, s) { const m = s.match(rx); return m ? [m[0].trim(), s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)] : ['', s]; }
  function workstream(text, lists, inbox) {
    let best = inbox, score = 0;
    for (const [name, words] of Object.entries(KEYWORDS)) {
      if (!lists.includes(name)) continue;
      const n = (text.match(new RegExp(`\\b(${words})\\b`, 'gi')) || []).length;
      if (n > score) { best = name; score = n; }
    }
    return best;
  }
  function parse(text, workstreams, inbox) {
    const t = norm(text);
    if (!t) return null;
    if (BRIEF.test(t.toLowerCase())) return {intent: 'brief', kind: 'other', title: '', workstream: inbox, when: '', time: '', duration_min: 0, priority: 'P2'};
    const lists = [...workstreams, inbox];
    let ws = '', body, m = t.match(ADD);
    if (m) body = m[1];
    else {
      m = t.match(ADD_TO);
      if (!m || !lists.includes(LIST_NAMES[m[2].toLowerCase()])) return null;
      body = m[1] + (m[3] || ''); ws = LIST_NAMES[m[2].toLowerCase()];
    }
    const em = body.match(END_LIST);                    // an explicit list at the end: "... to my PhD list", "... in college"
    if (em && lists.includes(LIST_NAMES[em[1].toLowerCase()])) { ws = LIST_NAMES[em[1].toLowerCase()]; body = body.slice(0, em.index); }
    let mins = 30;
    const dm = body.match(DURATION);
    if (dm) {
      mins = dm[1] ? (/^h/.test(dm[2]) ? +dm[1] * 60 : +dm[1]) : (/^half/.test(dm[3]) ? 30 : 60);
      body = body.slice(0, dm.index) + ' ' + body.slice(dm.index + dm[0].length);
    }
    let timeWords, when;
    [timeWords, body] = cut(TIME, body);
    [when, body] = cut(DATE, body);
    const prio = new RegExp(P1.source, 'i').test(body) ? 'P1' : new RegExp(P3.source, 'i').test(body) ? 'P3' : 'P2';
    if (prio === 'P1') body = body.replace(P1, ' '); else if (prio === 'P3') body = body.replace(P3, ' ');
    let title = body.replace(/\s+/g, ' ').replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '');
    title = title.replace(/\s+\b(on|at|by|for|to|in|before|due|until|and)$/i, '').replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '').replace(/^the\s+/i, '');
    if (title.length < 2) return null;
    title = title[0].toUpperCase() + title.slice(1);
    return {intent: 'add_task', kind: 'other', title, workstream: ws || workstream(title, lists, inbox), when: when.toLowerCase(),
            time: timeWords.toLowerCase(), duration_min: mins, priority: prio};
  }
  const api = {parse, workstream};
  if (typeof module !== 'undefined') module.exports = api; else root.JQuick = api;
})(this);
