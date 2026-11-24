// Apps built with Zubra outside this repository, on the published packages, shown on the landing
// page under "Built with Zubra". Each runs in production: `live` is where (https), `source` its
// repository. demos/test/landing.test.js checks each is on the page, is https, and answers 200.
//
// The Potomac Solutions apps are demos for made-up businesses: nothing in them is really sold,
// booked or sent, and their data is cleared overnight.
const potomac = (repo) => `https://github.com/potomac-solutions/${repo}`;

export const builtWith = [
  { id: 'open-parlor', title: 'open.parlor', by: 'Journey to Code',
    live: 'https://open-parlor.up.railway.app/', source: 'https://github.com/journey-to-code-org/open.parlor',
    blurb: 'Fifty-six card, board, word and arcade games for families. React, Vue, Svelte, Solid and Angular share one .zb component library; the game rooms run on @zubra/sync, and a conformance suite checks Zubra in three browsers.' },
  { id: 'counter', title: 'Hickory Hollow Bakehouse', by: 'Potomac Solutions',
    live: 'https://counter.potomac.solutions/', source: potomac('counter'),
    blurb: 'Order ahead and pick up at the side window. The menu shows what’s left, live, and the kitchen moves each order along on a board the guest’s phone follows.' },
  { id: 'outfitter', title: 'Lakeside Paddle & Pedal', by: 'Potomac Solutions',
    live: 'https://outfitter.potomac.solutions/', source: potomac('outfitter'),
    blurb: 'Kayak, board and bike rentals: pick the days, sign the waiver at home, and show a code at the dock.' },
  { id: 'work-ticket', title: 'Backbone Mountain Taxidermy', by: 'Potomac Solutions',
    live: 'https://work-ticket.potomac.solutions/', source: potomac('work-ticket'),
    blurb: 'Drop off and track: a customer follows their job by tag number from drop-off to pickup, while the shop works a live job board.' },
  { id: 'front-desk', title: 'Yough Valley Hair Co.', by: 'Potomac Solutions',
    live: 'https://potomac-solutions.github.io/front-desk/', source: potomac('front-desk'),
    blurb: 'One server, two businesses at their own addresses: a salon that books chairs online, and a volunteer fire company that runs its hall’s events.' },
  { id: 'showroom', title: 'Old Depot Antiques', by: 'Potomac Solutions',
    live: 'https://showroom.potomac.solutions/', source: potomac('showroom'),
    blurb: 'One-of-a-kind stock: hold a piece for a day or buy it, and every open page shows at once when it’s held or sold.' },
  { id: 'cinestack', title: 'Hemlock Ridge Cinema 8', by: 'Potomac Solutions',
    live: 'https://cinestack.potomac.solutions/', source: potomac('CineStack'),
    blurb: 'Pick a film, a time and the exact seat through @zubra/actions; the ticket is on your phone, and door staff scan it.' },
  { id: 'tailgate', title: 'Tailgate', by: 'Potomac Solutions',
    live: 'https://tailgate.potomac.solutions/', source: potomac('tailgate'),
    blurb: 'Farm to door: one cart across several farms and one payment, with each farm’s stock kept in @zubra/sync and edited offline.' },
  { id: 'apex-auto', title: 'Apex Auto Supply', by: 'Potomac Solutions',
    live: 'https://apex-auto.potomac.solutions/', source: potomac('apex-auto'),
    blurb: 'A call desk for the parts counter: take a call, look up the customer and vehicle, and work a shared queue with coworkers.' },
];
