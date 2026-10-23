const HELP_SECTIONS = [
  { id: 'help-about', title: 'What this app is' },
  { id: 'help-data', title: 'Your data' },
  { id: 'help-quickstart', title: 'Quick start' },
  { id: 'help-glossary', title: 'Glossary' },
  { id: 'help-howto', title: 'How to…' },
  { id: 'help-requests', title: 'Parts requests' },
  { id: 'help-library', title: 'Library' },
  { id: 'help-install', title: 'Install on your phone' },
  { id: 'help-desktop', title: 'Desktop tips' },
  { id: 'help-ai', title: 'AI assistant' },
  { id: 'help-roles', title: 'Roles and permissions' },
  { id: 'help-faq', title: 'FAQ' },
];

function scrollToSection(id) {
  return (event) => {
    event.preventDefault();
    const target = document.getElementById(id);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
}

function helpSection(h, id, title, ...children) {
  return h('section', { id, class: 'help-section' }, h('h2', {}, title), ...children);
}

function helpList(h, items) {
  return h('ul', { class: 'help-list' }, ...items.map((item) => h('li', {}, ...item)));
}

function helpSteps(h, steps) {
  return h('ol', { class: 'help-steps' }, ...steps.map((step) => h('li', {}, step)));
}

function helpGlossary(h, entries) {
  return h(
    'dl',
    { class: 'help-glossary' },
    ...entries.flatMap(([term, definition]) => [
      h('dt', {}, term),
      h('dd', {}, definition),
    ]),
  );
}

function helpHowTos(h, entries) {
  return helpList(
    h,
    entries.map(([lead, rest]) => [h('strong', {}, lead), ...rest]),
  );
}

function helpQa(h, question, answer) {
  return [h('h3', { class: 'help-question' }, question), h('p', {}, answer)];
}

function helpAbout(h) {
  return helpSection(
    h,
    'help-about',
    'What this app is',
    h(
      'p',
      {},
      'A maintenance log for a garment shop: repairs, machines, parts and preventive maintenance (PM) in one place. It is built for use on a phone on the shop floor — short forms, big buttons, and it keeps working when the Wi-Fi drops.',
    ),
    h(
      'p',
      {},
      'On the team server, everyone signs in with a team account and shares one log: you see what your coworkers log, every record says who last edited it, and nothing is lost when two people save at the same time.',
    ),
  );
}

function helpData(h) {
  return helpSection(
    h,
    'help-data',
    'Your data',
    helpList(h, [
      [
        'One shared log on the company server. ',
        'Everything you see is the team’s log stored on your company’s server. Sign in with your team account and you see everyone’s records, and they see yours.',
      ],
      [
        'Who edited what. ',
        'Every record shows ',
        h('strong', {}, 'Edited by <Name> · <time>'),
        ' (hold to see the exact time), and detail pages also show who created it. Your own edits that have not reached the server yet say ',
        h('strong', {}, 'Not synced yet'),
        '.',
      ],
      [
        'History for every record. ',
        'Open any service order, machine, part or PM task and scroll to ',
        h('strong', {}, 'History'),
        ' to see every saved version — who changed it, when, and which fields changed. Nothing is thrown away, not even versions that were saved over.',
      ],
      [
        'Offline is fine. ',
        'The status pill in the header says what is happening: ',
        h('strong', {}, 'Synced'),
        ' (you have everything), ',
        h('strong', {}, 'Saving… (n)'),
        ' (sending n of your changes), ',
        h('strong', {}, 'Offline – n changes waiting'),
        ' (no server, your edits are queued on this device), ',
        h('strong', {}, 'Sign in needed'),
        ', or ',
        h('strong', {}, 'n changes failed to sync'),
        ' (the server rejected a change — Settings shows why and offers Retry).',
      ],
      [
        'Backups live on the server. ',
        h('strong', {}, 'Settings → Back up now'),
        ' saves a backup file on the server with one click — anyone signed in can do it. The server also backs itself up automatically every night. Admins can download backup files.',
      ],
      [
        'Admins manage teammates. ',
        'In Settings, admins add users, set roles (administrator or technician), disable accounts and reset passwords. Accounts are never self-serve.',
      ],
      [
        'Standalone copies. ',
        'If this app was opened without a team server, that copy keeps everything in this browser, on this device, and ',
        h('strong', {}, 'Settings → Export backup (JSON)'),
        ' is the way to hand records over.',
      ],
    ]),
  );
}

function helpQuickStart(h) {
  return helpSection(
    h,
    'help-quickstart',
    'Quick start',
    h('p', {}, 'Five steps and the app is doing its job:'),
    helpSteps(h, [
      'Add your machines (Machines → + Add machine) — or, if your shop is moving over from the old single-device app, an administrator imports its backup in Settings → Import v1 data.',
      'Log a repair — Service Orders → + Service order, pick the machine, say what happened.',
      'Update the service order’s status as you work: open it and move it along — In progress, Waiting parts, Waiting tech, Done.',
      'Add the parts you keep in stock (Parts → + Add part) and set a minimum quantity for each, so the app warns you before you run out.',
      'Add PM tasks (Preventive Maintenance → + Add PM task) with an interval in days, and the app tracks what is due and when.',
    ]),
  );
}

function helpGlossarySection(h) {
  return helpSection(
    h,
    'help-glossary',
    'Glossary',
    helpGlossary(h, [
      ['Work order / job', 'One repair or task, from the moment it is logged until it is marked Done. The app now calls these service orders; “job” and “work order” mean the same thing here.'],
      ['Service order number', 'Each service order gets a sequential number from the server, shown as SO-0001, SO-0002 and so on. A new order written offline says SO-pending until the next sync gives it its number.'],
      ['Breakdown', 'A repair logged because a machine stopped working. The app offers to mark that machine Down while the service order is open, and Running again after.'],
      ['Priority', 'How urgent a service order is: None, Low, Medium (the default), High or Urgent. Urgent service orders also appear in “Needs attention” on Home. Old records with the previous “Normal” value are shown as Medium.'],
      ['Category', 'What kind of work it is: Mechanical, Electrical, Pneumatic, Facility, Safety, Cleaning or Other.'],
      ['Due date', 'When a service order should be finished. Overdue ones show the due date in red, and “Overdue” is also one of the filters.'],
      ['Requested by', 'Free text for who asked for the work — an operator or supervisor name.'],
      ['Assignee', 'A coworker, an outside contractor or a user account assigned to a service order. Assigned people show as initials avatars with their names in a tooltip.'],
      ['Coworker', 'Someone on your shop-floor team kept in the Coworkers list: role, shift, skills, phone and email, and optionally the team login they use. Coworkers can be assigned to service orders and get labour hours.'],
      ['Outside contractor', 'A company that services machines for you, kept in the Outside Contractors list: trade, contact person, phone, email, what they worked on and how many hours.'],
      ['Contractor rate', 'An optional hourly rate on a contractor, in dollars per hour. Only roles with the Contractor rates permission can see rates and costs, or change them.'],
      ['Checklist', 'A list of steps on a service order you can tick off one by one — add steps, reorder them, tick and remove them.'],
      ['Labour hours', 'Who worked on a service order and for how long: each entry is a person, a date and hours in quarter-hour steps (plus an optional note). The total adds these plus any legacy minutes recorded before v3.'],
      ['Attachment', 'A photo or PDF attached to a service order. Photos are shrunk to at most 1600 px on the long side before upload; PDFs upload as they are. Attaching needs a connection — the order itself still saves offline.'],
      ['Board view', 'The Service Orders page as columns per status (Open, In progress, Waiting parts, Waiting tech, Done — last 7 days). Move a card by dragging it between columns, or with the “Move to…” button on each card.'],
      ['Calendar view', 'The Service Orders page as a month grid by due date: at most three orders per day are listed, then “+N more”.'],
      ['Machine type', 'What kind of machine it is — single-needle lockstitch, bartack, 5-thread overlock and other garment-shop types. If none of them fit, pick Other (type your own) and give it your own name; the types you use are remembered for next time.'],
      ['PM (preventive maintenance)', 'A small, scheduled check that keeps a machine working — cleaning, oiling, checking tension. Example: clean and oil the single-needle machine every 30 days.'],
      ['PM interval', 'How often a PM task repeats, in days from the last time it was done. A 30-day task is due again 30 days after you mark it done.'],
      ['PM priority', 'How urgent a PM task is: None, Low, Medium (the default), High or Urgent. Marking a task done copies this to the completion service order.'],
      ['Estimated hours', 'The rough time a PM task takes, in quarter-hour steps (0.25, 0.5, …). Shown in the Est. hours column on the Preventive Maintenance page.'],
      ['PM checklist template', 'The steps of a PM task — add them, reorder them, remove them. When you mark the task done, they are copied to the completion service order with every step already ticked.'],
      ['Machine photos', 'Photos kept on the machine’s own page: add them under Photos and manuals on the machine form; they show as a gallery on the machine detail page.'],
      ['Manuals', 'PDF manuals kept on a machine’s page. The machine detail lists each manual with its file name and size, plus an Open link that opens it in a new tab.'],
      ['Paused PM', 'The PM tasks of a machine that is In storage or Retired are paused: they do not count as overdue or due soon, and they sit in the “Paused” group on the Preventive Maintenance page. Set the machine back to Running and the tasks resume with their due dates unchanged.'],
      ['Status monitor', 'The live tab of the Statistics page: tiles counting machines by status (Running, Down, In storage, Retired — tap one to open the filtered Machines list), the “Down now” table of every machine that is down (how long, its oldest open breakdown order and who is assigned), longest first, and the Today strip with service orders opened today, closed today, overdue now and PM due today. It refreshes after every sync.'],
      ['MTTR', 'Mean time to repair: the average hours from when a breakdown was reported to when it was completed, over the chosen Statistics report range. Shown as “—” when nothing was completed in the range.'],
      ['PM compliance', 'The share of PM service orders completed in the Statistics report range that were finished on or before their due date at the time.'],
      ['Overdue', 'Past its due date and not done yet.'],
      ['Due soon', 'Due within the next 3 days.'],
      ['Open', 'Logged, but nobody has started on it yet.'],
      ['In progress', 'Someone is working on it right now.'],
      ['Waiting parts', 'Paused until an ordered part arrives.'],
      ['Waiting tech', 'Paused until you (or an outside repair shop) can get to it.'],
      ['Done', 'Finished and closed.'],
      ['Downtime', 'How many minutes the machine was out of service because of this service order. Entered on the order as “Machine downtime (minutes)”.'],
      ['Labour minutes', 'How many minutes you spent working on the service order — your time, tracked separately from downtime. New entries use quarter-hour labour entries instead.'],
      ['Low stock / minimum quantity', 'Every part has a minimum quantity. When the quantity on hand falls to it or below, the part is flagged Low so you can reorder in time.'],
      ['In storage', 'A machine that is put away instead of working on the floor. Service orders and PM tasks can still be logged for it, but the app leaves its status alone and pauses its PM while it is stored.'],
      ['Building item', 'Something that is part of the building — a drain, a gutter run, a light — logged like a machine so it can have service orders and PM tasks too.'],
    ]),
  );
}

function helpHowTo(h) {
  return helpSection(
    h,
    'help-howto',
    'How to…',
    helpHowTos(h, [
      [
        'Log a repair in under a minute',
        ' — Service Orders → + Service order, pick the machine, type what happened, then Save service order. Assignees, checklist, labour, parts, timings and attachments can all be added on the same form, before or after saving.',
      ],
      [
        'Filter and find service orders',
        ' — open Service Orders and press Filters: status (Not done is the default), priority, kind, due date (Overdue · Due this week · No due date), category, machine type, machine, assignee and a created-date range. Active filters sit as removable chips above the list, with Clear all next to them. Your filter choices are remembered on this device.',
      ],
      [
        'Use the board',
        ' — on a desktop, switch the Service Orders view to Board: one column per status. Drag a card to another column to change its status, or open its “Move to…” menu — that one works from the keyboard too.',
      ],
      [
        'See what is due when',
        ' — switch the view to Calendar: service orders sit in a month grid by due date. Step through months with Previous / Next; tap an order to open it.',
      ],
      [
        'Assign people to a service order',
        " — open the order's form and go to Assign: pick coworkers, outside contractors and users, then Add. Assigned people show as initials avatars everywhere the order appears.",
      ],
      [
        'Track labour hours',
        ' — in the order form under Labour, add an entry per person and day: hours go in quarter-hour steps (0.25, 0.5, …) with an optional note. The running total shows next to the list; hours recorded as minutes before v3 keep counting.',
      ],
      [
        'Attach photos and PDFs',
        ' — in the order form under Attachments, press Add photo or PDF. Photos are shrunk before uploading; PDFs upload as they are. Tap an attachment to view it full size. Uploading needs a connection to the server, but the order itself still saves offline.',
      ],
      [
        'Keep machine photos and manuals',
        ' — Machines → open the machine → Edit machine → Photos and manuals. Photos are shrunk before uploading and show as the machine’s gallery; PDF manuals are listed under Manuals with their size and an Open link that opens them in a new tab.',
      ],
      [
        'Close a service order and deduct parts',
        ' — open the order, add the parts it used, then set its status to Done. Parts are deducted from stock once, at the moment the order is marked Done. If you reopen it, the used parts go back into stock.',
      ],
      [
        'Mark a PM done',
        ' — Preventive Maintenance → open the task → Mark done. The app logs a done PM service order that copies the task’s priority, category, assignees and checklist (every step ticked), then asks for optional labour hours (person + hours) to add to that order, and sets the next due date from the interval.',
      ],
      ['Find a part', ' — go to Parts and type a name or part number into the search box.'],
      [
        'Add a coworker',
        ' — People → Coworkers → + Add coworker: name, role, shift, phone, email and skills, and optionally link their team login. Inactive coworkers stay in the list behind the Inactive filter.',
      ],
      [
        'Add an outside contractor',
        ' — People → Outside Contractors → + Add contractor: company, trade, contact person and the machines they service. Open a contractor to see the service orders they worked on and their hours.',
      ],
      [
        'See what is down right now',
        ' — Statistics → Status monitor: the tiles count machines by status (tap one to open the filtered Machines list), the “Down now” table lists every machine that is down with its type, down since, oldest open breakdown order, assignees and hours down (longest first, “All machines are running” when none is down), and the Today strip counts service orders opened and closed today, overdue now and PM due today.',
      ],
      [
        'Read the statistics reports',
        ' — Statistics → Reports and pick Last 30, 90 or 365 days: KPI tiles (open service orders, overdue, MTTR, PM compliance, downtime hours, labour hours) and charts for service orders by status and priority, created vs completed per week, downtime hours by machine type, top machines by breakdowns (with MTBF days), and labour hours by outside contractor and coworker. Every chart has a Show table toggle with the same numbers as an accessible table, and an Export CSV button; contractor costs show only for roles with the Contractor rates permission.',
      ],
      [
        'Call or copy a contact',
        ' — on a coworker or contractor page, phone numbers are call links and email addresses are mail links. The Copy button next to them copies the text; if copying is blocked, the text is selected so you can copy it yourself.',
      ],
      [
        'See a machine’s history',
        ' — Machines → open the machine → Repair history lists its service orders, newest first.',
      ],
      ['Export to Excel (CSV)', ' — Settings → Export service orders (CSV). The file opens in Excel, Numbers or Google Sheets.'],
      [
        'Back up',
        ' — Settings → Back up now saves a backup of the whole shared log on the server with one click; the server also does it automatically every night. Settings → Export backup (JSON) saves a local file of what this device holds.',
      ],
    ]),
  );
}

function helpInstall(h) {
  return helpSection(
    h,
    'help-install',
    'Install on your phone',
    helpList(h, [
      ['Android (Chrome): open the ⋮ menu and tap “Install app” (or “Add to Home screen”).'],
      ['iPhone (Safari): tap Share, then “Add to Home Screen”.'],
      [
        'After your first visit, the app loads with no signal — the whole thing is cached on the device. On the team server this needs the HTTPS address (offline install and offline opening do not work over plain HTTP); ask whoever runs the server for the HTTPS link.',
      ],
    ]),
  );
}

/* v4 (SPEC-v4.md section 7): how to gather request lines, send them to the
   accountant, and print/copy the sheet. */
function helpRequests(h) {
  return helpSection(
    h,
    'help-requests',
    'Parts requests',
    h(
      'p',
      {},
      'A parts request gathers everything you need to buy into one numbered price table (PR-0001, PR-0002…). It starts as a Draft and stays one for days while you add lines from anywhere; when it is complete, Mark sent turns it into a clean sheet you can print, save as PDF, paste into an email or hand to the accountant. Mark received closes it — stock quantities are not changed by that; record what actually arrived with the usual stock buttons or a service order.',
    ),
    h('h3', { class: 'help-question' }, 'Gathering lines'),
    helpSteps(h, [
      'Parts requests → New request gives you an empty draft: title, supplier, needed-by date, who asked, the HST % (13 by default) and notes all live in the header.',
      'On the request, Add line starts a free-text line for things that are not in the catalogue — type what you need, a quantity and a price when you know it. Typing a description also offers matching catalogue parts; picking one fills the part number, unit and supplier for you.',
      'Away from the request: Add to parts request on a part (its row or its detail page) adds that part at the quantity that brings you back above the minimum. Parts → Low stock only → Add all low-stock to request adds every low part in one go. Request parts on a service order adds a line tied to that order and that machine, then opens the request with the description ready to type.',
      'Lines you do not have a price for yet just leave the Unit price blank: they count as “Price to be confirmed” and the footer tells you how many there are.',
      'Up and down reorder lines (the Item # follows), the × removes one, and Machine notes which machine a line is for.',
    ]),
    h('h3', { class: 'help-question' }, 'Sending and the sheet'),
    helpList(h, [
      [
        'Mark sent',
        ' — moves the request to Sent and stamps the time. If lines still have no price it asks once whether you really want to send it; a sent request stays editable, so you can add the prices once the supplier replies.',
      ],
      [
        'Mark received',
        ' — stamps the received time; Back to draft reopens a sent request; Cancel request retires it but keeps it on record and printable.',
      ],
      [
        'View sheet',
        ' — the white printable page: Print / Save as PDF (your browser’s print dialog, “Save as PDF” as the destination), Copy table (pastes as a real table into Outlook, Gmail or Excel; a CSV download is offered where the browser blocks copying), and Download CSV for Excel, totals included.',
      ],
    ]),
    h(
      'p',
      {},
      'Only drafts accept lines added from other pages — a request that is already sent will not silently grow. Totals are always calculated from the lines (Subtotal before HST, HST, Grand total), never stored, so changing a price or the HST % updates everything at once. A Muse agent connected through the API can read and update requests the same way.',
    ),
  );
}

/* v4 (SPEC-v4.md sections 4.3 and 7): the repair Library — manuals the AI
   can read and repair methods, on the machine and off service orders. */
function helpLibrary(h) {
  return helpSection(
    h,
    'help-library',
    'Library',
    h(
      'p',
      {},
      'The Library keeps your machine manuals and your own repair methods in one place. It has two tabs — Repair methods and Manuals — with a search across titles, models, tags, symptoms and step text, and filters by machine type, model and tag. Every item can name a machine type (all machines of that type), model numbers (compared ignoring spaces and dashes, so “DDL-8700-7” matches “DDL 8700 7”) and specific machines. Open a machine and the Library section lists everything that applies to it, repair methods first.',
    ),
    h('h3', { class: 'help-question' }, 'Manuals the AI can read'),
    helpList(h, [
      [
        'Upload ',
        'a PDF from the Manuals tab → New manual (up to 50 MB per PDF; photos can ride along too). Give it a title, the machine type or models it covers, and tags so it turns up in searches.',
      ],
      [
        'The badge on each PDF ',
        'says whether the AI can use it: ',
        h('strong', {}, 'AI can read · N pages'),
        ' — the server pulled the text out of the PDF; ',
        h('strong', {}, 'Scanned — AI can’t read'),
        ' — the PDF is just pictures, so type the key specs (needle charts, timing marks, settings) into ',
        h('strong', {}, 'Text for the AI'),
        ' on the manual; ',
        h('strong', {}, 'Reading…'),
        ' — the server is still working, the page re-checks on its own; ',
        h('strong', {}, 'Couldn’t read'),
        ' — the file is damaged or encrypted. Offline, no badge shows at all.',
      ],
      [
        'Text for the AI ',
        'is that box of typed or pasted key specs. A scanned manual is invisible to the AI without it — whatever you put there is what the AI will know about that manual.',
      ],
    ]),
    h('h3', { class: 'help-question' }, 'Repair methods'),
    helpSteps(h, [
      'Write the fix as it happens: Symptom (what goes wrong), Cause, numbered Steps (add, remove and reorder them), Tools & parts, and Safety — the safety text always shows in a highlighted box, so put lockout and power-off points there.',
      'From a machine: open the machine → Library → + Add repair method; the method starts linked to that machine and its model.',
      'From a service order: finish the work, then on the completed order press Save as repair method — the form comes pre-filled with the order’s title, the problem as the symptom, the action taken split into steps, the machine and its model, and a link back to the order (“From SO-0042”).',
      'Share what you know: tags like “thread break” or “timing” help the search find the right method months later.',
    ]),
    h(
      'p',
      {},
      'Technicians and administrators can add and edit library items; viewers read them. Deleting a library item never touches the machine or the service order it came from.',
    ),
  );
}

function helpShortcutsTable(h) {
  const key = (label) => h('kbd', {}, label);
  const row = (keys, what) =>
    h('tr', {}, h('td', { class: 'help-keys' }, ...keys), h('td', {}, what));
  return h(
    'table',
    { class: 'help-shortcuts' },
    h(
      'thead',
      {},
      h('tr', {}, h('th', { scope: 'col' }, 'Key'), h('th', { scope: 'col' }, 'What it does')),
    ),
    h(
      'tbody',
      {},
      row([key('n')], 'Start a new service order'),
      row([key('/')], 'Focus the search box on the current page'),
      row([key('g'), ' then ', key('h')], 'Go to Home'),
      row([key('g'), ' then ', key('j')], 'Go to Service Orders'),
      row([key('g'), ' then ', key('m')], 'Go to Machines'),
      row([key('g'), ' then ', key('p')], 'Go to Parts'),
      row([key('g'), ' then ', key('k')], 'Go to Preventive Maintenance'),
    ),
  );
}

function helpDesktop(h) {
  return helpSection(
    h,
    'help-desktop',
    'Desktop tips',
    h(
      'p',
      {},
      'On a wide screen (1024 px or more), the app shows a dark sidebar on the left in place of the bottom tab bar, lists turn into tables you can sort by clicking a column header, and opening a row shows its details in a pane beside the list. On Service Orders you can also switch between List, Board and Calendar views; filters and pagination sit above the table, and forms (new or edit) open in a panel that slides in from the right — Esc closes it after a “Discard changes?” check when anything is unsaved. The top bar has a global search box that finds service orders, machines, parts and people; pick a result with the arrow keys and press Enter. Statistics (Status monitor and Reports) sits between Preventive Maintenance and Machines in the sidebar; Coworkers and Outside Contractors live under People in the sidebar. The sidebar can be collapsed to an icon rail with the button at its top. On phones the bottom bar has Home, Orders, Prev. Maint., Machines and More; the Service Orders filters open as a sheet from the bottom.',
    ),
    h('p', {}, 'Keyboard shortcuts (desktop only — they never fire while you are typing in a text field):'),
    helpShortcutsTable(h),
  );
}

function helpFaq(h) {
  return helpSection(
    h,
    'help-faq',
    'FAQ',
    ...helpQa(
      h,
      'Can two people use the same log?',
      'Yes — that is the normal way. Everyone signs in to the team server with their own account and shares one log. Each person works on their own device, and every record says who last edited it.',
    ),
    ...helpQa(
      h,
      'What happens when two people edit the same service order?',
      'The later save wins, and nothing is lost: the app tells the second saver that they saved over changes by the first, and both versions stay in the order’s History section. If you both close service orders that use the same part, both stock deductions apply.',
    ),
    ...helpQa(
      h,
      'What does the pill in the header mean?',
      'It is the sync status. “Synced” means you have everything and the server has all of your changes. “Saving… (n)” means n of your changes are being sent. “Offline – n changes waiting” means the server cannot be reached and your edits are safely queued on this device. “Sign in needed” means you have to sign in again. “n changes failed to sync” means the server rejected a change — Settings shows why and offers Retry.',
    ),
    ...helpQa(
      h,
      'I made edits on the shop floor with no Wi-Fi. Where are they?',
      'Still here, marked “Not synced yet”, and counted in the pill as waiting changes. They send automatically as soon as the server is reachable again — nothing to press.',
    ),
    ...helpQa(
      h,
      'How do backups work?',
      'Anyone signed in can tap Settings → Back up now: that saves a backup file on the server immediately. On top of that the server backs itself up automatically every night, and admins can download the backup files.',
    ),
    ...helpQa(
      h,
      'Will I lose data if the app is updated?',
      'No. Updates replace the app itself, not the records. Records live on the team server (and each device keeps a working copy); an update just refreshes the app shell.',
    ),
    ...helpQa(
      h,
      'Why does a page say “View only”?',
      'Your role gives you Read access to that area: you can open and read everything, but the create, edit and delete controls stay hidden. An administrator can change that in Admin → Roles & permissions. Areas you have no access to at all are simply not shown.',
    ),
    ...helpQa(
      h,
      'I changed something while I still could — why is it in the failed list?',
      'If an administrator took away write access between your edit and the next sync, the server rejects that change. Settings shows “You no longer have permission to change …” with a Retry button in case it was a mistake.',
    ),
  );
}

/* AI assistant (SPEC-v3.md section 9, client help for V3-M8). */
function helpAi(h) {
  return helpSection(
    h,
    'help-ai',
    'AI assistant',
    h(
      'p',
      {},
      'The round chat button at the bottom right of every page opens the AI assistant. It answers questions about this log: which machines are down, what maintenance is overdue, which parts are low on stock, or a short summary of the week.',
    ),
    helpList(h, [
      [
        h('strong', {}, 'Read-only: '),
        'the assistant can look at records but never change them. It answers in text only.',
      ],
      [
        h('strong', {}, 'Draft service orders: '),
        'it may suggest a draft service order as a card. "Open as new service order" opens the normal form pre-filled — nothing is saved until you press Save there.',
      ],
      [
        h('strong', {}, 'Your chats: '),
        'history is stored per user and everyone can clear only their own.',
      ],
    ]),
    h(
      'p',
      {},
      'Privacy: questions and the records needed to answer them are sent to the configured AI provider.',
    ),
    h(
      'p',
      {},
      'Admins turn the assistant on and choose the provider (opencode or any OpenAI-compatible server) in Settings → AI assistant. The button stays hidden while the assistant is off.',
    ),
  );
}

/* Roles and permissions (SPEC-v3.md section 13, client help for V3-M9).
   The section itself is for administrators; the "View only" note for
   everyone lives in the FAQ below. */
function helpRoles(h) {
  return helpSection(
    h,
    'help-roles',
    'Roles and permissions',
    h(
      'p',
      {},
      'Admin → Roles & permissions shows a matrix: every column is a role, every row a part of the app. Each cell is None (the area disappears and stays hidden on that device), Read (view only) or Write (create, edit, delete).',
    ),
    helpList(h, [
      [h('strong', {}, 'Who manages this: '), 'only roles with Write on Users & roles see the Admin page and can change other roles, disable accounts or reset passwords.'],
      [h('strong', {}, 'Changing levels: '), 'pick Read or Write in the matrix and press Save. A bar reminds you while changes are unsaved; Discard puts the role back.'],
      [h('strong', {}, 'New roles: '), 'create one from scratch or as a copy of an existing role, then rename or delete it. A role that still has users cannot be deleted — move them first.'],
      [h('strong', {}, 'Built-in roles: '), 'Administrator, Technician and Viewer come with the app. The Administrator role keeps every permission and cannot be changed or deleted.'],
      [h('strong', {}, 'History: '), 'every role lists who changed which areas, from what level to what. Entries written by the migration itself say "System".'],
      [h('strong', {}, 'Takes effect right away: '), 'the server re-checks the role on every request, and everyone\'s app follows on their next sync. A change you do not have permission for anymore lands in the failed-changes list in Settings.'],
    ]),
    h(
      'p',
      {},
      'Areas: Service Orders, Preventive Maintenance, Machines, Parts & Stock, Parts requests, Library, Coworkers, Outside Contractors, Contractor rates & costs, Statistics, Photos & files, Backups, AI assistant, Branding & AI settings, and Users & roles.',
    ),
  );
}

export function renderHelp(h, { isAdmin = false } = {}) {
  const sections = isAdmin ? HELP_SECTIONS : HELP_SECTIONS.filter((section) => section.id !== 'help-roles');
  return h(
    'div',
    { class: 'page help-page' },
    h('div', { class: 'page-head' }, h('h2', {}, 'Help')),
    h(
      'p',
      { class: 'muted' },
      'A short guide: what this app is, where your data lives, and how to use each part of it.',
    ),
    h(
      'nav',
      { class: 'help-toc', 'aria-label': 'Help sections' },
      h(
        'ul',
        {},
        ...sections.map((section) =>
          h(
            'li',
            {},
            h(
              'a',
              { href: `#${section.id}`, onclick: scrollToSection(section.id) },
              section.title,
            ),
          ),
        ),
      ),
    ),
    helpAbout(h),
    helpData(h),
    helpQuickStart(h),
    helpGlossarySection(h),
    helpHowTo(h),
    helpRequests(h),
    helpLibrary(h),
    helpInstall(h),
    helpDesktop(h),
    helpAi(h),
    isAdmin ? helpRoles(h) : null,
    helpFaq(h),
  );
}