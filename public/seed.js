export const demoEvent = {
  id: 'evt-foe-2025',
  name: 'Future of Events 2025',
  dates: 'May 20–22, 2025',
  venue: 'Metro Toronto Convention Centre',
  city: 'Toronto',
  timezone: 'America/Toronto',
  readiness: 82,
};

export const navItems = [
  ['command','▦','Command Centre'], ['event','▣','Event Setup'], ['submissions','▤','Submissions'],
  ['review','✦','Review'], ['speakers','♙','Speakers'], ['schedule','▦','Schedule'],
  ['communications','✉','Communications'], ['tasks','☑','Tasks'], ['programme','▥','Programme'],
  ['integrations','⌘','Integrations'], ['settings','⚙','Settings']
];

export const submissions = [
  {id:'SUB-2567',title:'The future of attendee engagement',author:'Alex Morgan',category:'AI & Innovation',format:'Breakout',track:'AI & Innovation',status:'In review',reviews:1,requiredReviews:2,due:'May 28',abstract:'This session explores emerging strategies and technologies shaping the future of attendee engagement. We will examine real-world case studies and actionable frameworks to design experiences that are interactive, inclusive, and impactful.',speakers:['Alex Morgan','Jamie Lee'],attachments:['Session overview.pdf','Case study: BrightNorth Summit.pdf'],tags:['Engagement','Technology','Case study','Tools & tactics']},
  {id:'SUB-2568',title:'Designing inclusive hybrid experiences',author:'Priya Nair',category:'Experience Design',format:'Workshop',track:'Experience Design',status:'Assigned',reviews:0,requiredReviews:2,due:'May 29',abstract:'A practical workshop for designing hybrid experiences that work for participants in the room and online.',speakers:['Priya Nair'],attachments:['Inclusive-events-checklist.pdf'],tags:['Inclusion','Hybrid','Accessibility']},
  {id:'SUB-2569',title:'Data-driven event strategy',author:'Jordan Lee',category:'Event Operations',format:'Presentation',track:'Event Operations',status:'Assigned',reviews:0,requiredReviews:2,due:'May 29',abstract:'How programme teams can use operational evidence without losing sight of human experience.',speakers:['Jordan Lee'],attachments:[],tags:['Data','Operations']},
  {id:'SUB-2570',title:'Sustainable events: From intent to impact',author:'Taylor Kim',category:'Leadership',format:'Panel',track:'Leadership',status:'In review',reviews:1,requiredReviews:2,due:'May 30',abstract:'A candid discussion about moving sustainability from policy language into practical event decisions.',speakers:['Taylor Kim','Morgan Patel'],attachments:['Sustainability-framework.pdf'],tags:['Sustainability','Leadership']},
  {id:'SUB-2571',title:'The ROI of event innovation',author:'Morgan Chen',category:'Event Operations',format:'Presentation',track:'Event Operations',status:'Assigned',reviews:0,requiredReviews:2,due:'May 30',abstract:'A rigorous framework for measuring whether event innovation actually improves outcomes.',speakers:['Morgan Chen'],attachments:[],tags:['ROI','Innovation']},
  {id:'SUB-2572',title:'Personalization at scale',author:'Samira Patel',category:'AI & Innovation',format:'Presentation',track:'AI & Innovation',status:'Assigned',reviews:0,requiredReviews:2,due:'May 31',abstract:'Personalizing event journeys without creating fragmented experiences or privacy risk.',speakers:['Samira Patel'],attachments:[],tags:['Personalization','Privacy']},
  {id:'SUB-2573',title:'Community-building through events',author:'Riley Thompson',category:'Experience Design',format:'Panel',track:'Experience Design',status:'In review',reviews:1,requiredReviews:2,due:'Jun 1',abstract:'How to create durable communities before, during and after an event.',speakers:['Riley Thompson'],attachments:[],tags:['Community','Engagement']},
  {id:'SUB-2574',title:'Measuring what matters',author:'Casey Nguyen',category:'Event Operations',format:'Presentation',track:'Event Operations',status:'Assigned',reviews:0,requiredReviews:2,due:'Jun 1',abstract:'A practical measurement model for programme teams.',speakers:['Casey Nguyen'],attachments:[],tags:['Measurement']}
];

export const rubric = [
  {id:'rel',name:'Relevance',weight:25,rating:4},
  {id:'orig',name:'Originality',weight:20,rating:4},
  {id:'quality',name:'Content quality',weight:25,rating:5},
  {id:'practical',name:'Practical application',weight:20,rating:4},
  {id:'expertise',name:'Expertise',weight:10,rating:4}
];

export const formFields = [
  {id:'welcome',kind:'content',type:'Rich content',label:'Welcome content',description:'Introduce the call for speakers and share key guidelines.',required:false,always:true},
  {id:'title',kind:'input',type:'Short text',label:'Session title',description:'Use a clear, specific title that communicates the value of the session.',required:true,always:true},
  {id:'description',kind:'input',type:'Long text',label:'Session description',description:'Describe the topic, intended audience, key takeaways and why the session matters.',required:true,always:true,limit:1200},
  {id:'category',kind:'input',type:'Dropdown',label:'Session category',description:'Choose the category that best fits your session.',required:true,always:true,options:['AI & Innovation','Event Operations','Experience Design','Leadership']},
  {id:'format',kind:'input',type:'Dropdown',label:'Format',description:'Choose how you would like to present.',required:true,always:true,options:['Keynote','Presentation','Panel','Workshop','Breakout']},
  {id:'materials',kind:'input',type:'Long text',label:'Materials needed for workshop',description:'List any materials, equipment or room setup required to deliver your workshop.',required:true,always:false,limit:500,condition:{field:'format',operator:'equals',value:'Workshop'}},
  {id:'topics',kind:'input',type:'Multi select',label:'Topics',description:'Select all that apply.',required:true,always:true,options:['AI & Machine Learning','Data & Analytics','Event Operations','Experience Design','Sustainability']},
  {id:'files',kind:'input',type:'File upload',label:'Additional materials',description:'Upload slides, demos or supporting documents.',required:false,always:true}
];

export const categoryRouting = [
  ['AI & Innovation','AI & Emerging Tech Team'],['Event Operations','Operations Excellence Team'],
  ['Experience Design','Experience & Design Team'],['Leadership','Leadership & Strategy Team']
];

export const rooms = [
  {id:'main',name:'Main Stage',capacity:1200}, {id:'301a',name:'Room 301A',capacity:300},
  {id:'301b',name:'Room 301B',capacity:200}, {id:'302',name:'Room 302',capacity:150},
  {id:'303',name:'Room 303',capacity:150}
];

export const scheduleSessions = [
  {id:'s1',title:'Opening Keynote',speaker:'Alex Morgan',format:'Keynote',room:'main',start:480,end:540,attendance:1050},
  {id:'s2',title:'Event Tech Trends',speaker:'Priya Shah',format:'Presentation',room:'301a',start:480,end:540,attendance:280},
  {id:'s3',title:'Sustainability in Events',speaker:'Jordan Lee',format:'Panel',room:'301b',start:480,end:540,attendance:180},
  {id:'s4',title:'Workshop: CX Design',speaker:'Morgan Patel',format:'Workshop',room:'302',start:480,end:600,attendance:120},
  {id:'s5',title:'Volunteer Leadership',speaker:'Taylor Kim',format:'Breakout',room:'303',start:480,end:540,attendance:90},
  {id:'s6',title:'Fireside Chat',speaker:'Jamie Lee, Sam Chen',format:'Keynote',room:'main',start:555,end:615,attendance:1000},
  {id:'s7',title:'Data-Driven Events',speaker:'Ravi Patel',format:'Presentation',room:'301a',start:555,end:615,attendance:260},
  {id:'s8',title:'Community Building',speaker:'Casey Nguyen',format:'Panel',room:'301b',start:555,end:615,attendance:160},
  {id:'s9',title:'Accessibility in Events',speaker:'Avery Brooks',format:'Breakout',room:'303',start:555,end:615,attendance:85},
  {id:'s10',title:'AI in Event Ops',speaker:'Jamie Lee',format:'Presentation',room:'301a',start:600,end:660,attendance:150,conflict:true,track:'Technology'},
  {id:'s11',title:'Event Marketing 2025',speaker:'Jamie Lee',format:'Panel',room:'301b',start:600,end:660,attendance:160,conflict:true,track:'Marketing'},
  {id:'s12',title:'Workshop: Storytelling',speaker:'Lena Price',format:'Workshop',room:'302',start:615,end:735,attendance:120},
  {id:'s13',title:'Budgeting Basics',speaker:'Chris Moore',format:'Breakout',room:'303',start:630,end:690,attendance:80},
  {id:'s14',title:'Keynote: The Future',speaker:'Jamie Lee',format:'Keynote',room:'main',start:660,end:720,attendance:1100},
  {id:'s15',title:'Analytics Deep Dive',speaker:'Nina Singh',format:'Presentation',room:'301a',start:675,end:735,attendance:240},
  {id:'s16',title:'Social Media Strategy',speaker:'Diego Costa',format:'Panel',room:'301b',start:675,end:735,attendance:150},
  {id:'s17',title:'Breakout: Sponsorships',speaker:'Pat Williams',format:'Breakout',room:'303',start:705,end:765,attendance:80},
  {id:'s18',title:'Panel: Industry Leaders',speaker:'Various',format:'Keynote',room:'main',start:795,end:855,attendance:1000},
  {id:'s19',title:'Automation Tools',speaker:'Ella Chen',format:'Presentation',room:'301a',start:795,end:855,attendance:240},
  {id:'s20',title:'Brand Storytelling',speaker:'Marcus Lee',format:'Panel',room:'301b',start:795,end:855,attendance:150},
  {id:'s21',title:'Workshop: Measurement',speaker:'Sonia Gupta',format:'Workshop',room:'302',start:795,end:915,attendance:120},
  {id:'s22',title:'Emerging Trends',speaker:'Jordan Miles',format:'Breakout',room:'303',start:795,end:855,attendance:90},
  {id:'s23',title:'Event ROI',speaker:'Liam O’Connor',format:'Presentation',room:'301a',start:870,end:930,attendance:240},
  {id:'s24',title:'Content Marketing',speaker:'Aisha Khan',format:'Panel',room:'301b',start:870,end:930,attendance:150},
  {id:'s25',title:'Closing Keynote',speaker:'Morgan Patel',format:'Keynote',room:'main',start:960,end:1020,attendance:1100},
  {id:'s26',title:'Closing Panel',speaker:'Various',format:'Presentation',room:'301a',start:960,end:1020,attendance:250},
  {id:'s27',title:'What’s Next in Events',speaker:'Alex Morgan',format:'Panel',room:'301b',start:960,end:1020,attendance:150}
];

export const unscheduledSessions = [
  ['Hybrid Events 101','Presentation','Taylor Kim',120],['The Future of Ticketing','Presentation','Chris Moore',150],
  ['Workshop: Design Thinking','Workshop','Jordan Lee',120],['Breakout: Community','Breakout','Avery Brooks',80],
  ['Content ROI','Presentation','Diego Costa',120],['Lightning Talks','Panel','Various',200]
];

export const tasks = [
  {id:'t1',entityType:'Speaker',task:'Speaker agreement signed',context:'Alex Morgan · Opening Keynote',owner:'Alex Morgan',due:'May 10, 2025',dueNote:'8 days overdue',status:'Overdue',impact:'Critical',readiness:0,evidence:null},
  {id:'t2',entityType:'Session',task:'Session abstract & description finalised',context:'Dr. Priya Nair · AI in Action',owner:'Priya Nair',due:'May 16, 2025',dueNote:'2 days overdue',status:'Overdue',impact:'High',readiness:20,evidence:'Draft v2'},
  {id:'t3',entityType:'Speaker',task:'Speaker headshot submitted',context:'Jordan Lee · Future of Work Panel',owner:'Jordan Lee',due:'May 20, 2025',dueNote:'Due today',status:'At risk',impact:'Medium',readiness:50,evidence:'Headshot.jpg'},
  {id:'t4',entityType:'Session',task:'Presentation slide deck uploaded',context:'Samira Patel · Customer Experience',owner:'Samira Patel',due:'May 26, 2025',dueNote:'6 days',status:'On track',impact:'High',readiness:75,evidence:'Slides_v1.pptx'},
  {id:'t5',entityType:'Speaker',task:'Bio & short bio provided',context:'Dr. Liam Chen · Sustainability',owner:'Liam Chen',due:'May 28, 2025',dueNote:'8 days',status:'On track',impact:'Medium',readiness:100,evidence:'Bio.docx'},
  {id:'t6',entityType:'Speaker',task:'Travel details submitted',context:'Maria Gonzalez · Leadership Talk',owner:'Maria Gonzalez',due:'May 30, 2025',dueNote:'10 days',status:'Not started',impact:'Low',readiness:0,evidence:null},
  {id:'t7',entityType:'Session',task:'A/V requirements confirmed',context:'Ravi Singh · Tech Deep Dive',owner:'Ravi Singh',due:'May 30, 2025',dueNote:'10 days',status:'Not started',impact:'Low',readiness:0,evidence:null}
];

export const programmeSessions = [
  {id:'p1',day:'May 20',time:'9:00 – 9:45 AM',title:'Opening Keynote: The Next Chapter for Events',format:'Keynote',speaker:'Alex Morgan',speakerRole:'Futurist and Author',room:'Main Stage',building:'Level 200',track:'Leadership',saved:true,description:'Explore the macro forces reshaping the events industry and what they mean for organisers, attendees and communities in the years ahead.'},
  {id:'p2',day:'May 20',time:'10:15 – 11:00 AM',title:'AI in Action: Real-World Event Innovation',format:'Panel',speaker:'Alex Morgan, Jamie Lee, Priya Shah +1',speakerRole:'4 speakers',room:'Room 301',building:'North Building',track:'AI & Innovation',saved:false,description:'A grounded discussion about where AI is already changing event work and where caution is still required.'},
  {id:'p3',day:'May 20',time:'11:15 AM – 12:00 PM',title:'Designing Inclusive and Accessible Experiences',format:'Presentation',speaker:'Taylor Lee',speakerRole:'Accessibility Strategist',room:'Room 205',building:'Level 200',track:'Experience Design',saved:false,description:'Practical accessibility decisions for every stage of the programme lifecycle.'},
  {id:'p4',day:'May 20',time:'12:00 – 1:00 PM',title:'Networking Lunch',format:'Breakout',speaker:'',speakerRole:'',room:'Exhibit Hall',building:'North Building',track:'—',saved:false,description:'Lunch and structured networking.'},
  {id:'p5',day:'May 20',time:'1:15 – 2:00 PM',title:'From Data to Impact: Measuring What Matters',format:'Panel',speaker:'Five speakers',speakerRole:'',room:'Room 302',building:'North Building',track:'Event Operations',saved:true,description:'Move beyond vanity metrics with a practical measurement framework.'},
  {id:'p6',day:'May 20',time:'2:15 – 3:00 PM',title:'Hybrid Done Right: Lessons from the Field',format:'Presentation',speaker:'Jordan Kim',speakerRole:'Head of Events',room:'Room 206',building:'Level 200',track:'Leadership',saved:false,description:'What worked, what failed and what the team changed.'},
  {id:'p7',day:'May 21',time:'9:00 – 9:45 AM',title:'Community and Connection in a Digital World',format:'Panel',speaker:'Morgan Patel, Riley Thompson',speakerRole:'Panel',room:'Room 205',building:'Level 200',track:'Experience Design',saved:false,description:'Designing digital participation that creates real connection rather than passive attendance.'},
  {id:'p8',day:'May 22',time:'9:00 – 9:45 AM',title:'Closing Keynote: Building the Future Together',format:'Keynote',speaker:'Priya Nair',speakerRole:'Programme leader',room:'Main Stage',building:'Level 200',track:'Leadership',saved:false,description:'A closing synthesis of practical changes programme teams can make next.'}
];

export const integrations = [
  {name:'Airtable',icon:'A',optional:true,direction:'Bidirectional',scope:'Speakers & Sessions',mapping:'6 mapped fields',policy:'Program Cue wins on mapped event fields',status:'Healthy',activity:'132 records synced · 2m ago'},
  {name:'Accelevents',icon:'A',optional:false,direction:'Program Cue → Accelevents',scope:'Sessions, Speakers, Schedule',mapping:'10 mapped fields',policy:'Not applicable — one-way export',status:'Healthy',activity:'86 records synced · 5m ago'},
  {name:'Google Calendar',icon:'31',optional:false,direction:'Program Cue → Google Calendar',scope:'Session schedule',mapping:'5 mapped fields',policy:'Not applicable — one-way sync',status:'Healthy',activity:'14 events published · 7m ago'},
  {name:'Resend / Email',icon:'R',optional:false,direction:'Program Cue → Resend',scope:'Outbound transactional email',mapping:'3 mapped templates',policy:'Not applicable — one-way sync',status:'Healthy',activity:'412 emails sent · 12m ago'},
  {name:'Webhooks / API',icon:'↗',optional:false,direction:'Program Cue → Webhook',scope:'Real-time event publication',mapping:'4 event types',policy:'Not applicable — one-way delivery',status:'Healthy',activity:'28 deliveries · 1m ago'}
];

export const communicationTemplates = [
  ['General announcement',12],['Session reminder',8],['Logistics',6],['Schedule updates',5],['Promotions',4],['Surveys',3],['Post-event',4]
];
