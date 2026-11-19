import { pilot } from './settings.ts';

export const demoVersion=3;
export const illustrative=`Illustrative ${pilot.neighborhood} demo fixture. No field inspection.`;
export const simulated=`Simulated verification for the ${pilot.neighborhood} demo. No field inspection.`;
const amount=(base:number)=>({low:Math.round(base*.8),base,high:Math.round(base*1.2)});
const profile=(equipment:number,installation:number,maintenance:number|null)=>({
  equipment:amount(equipment),installation:amount(installation),preparation:amount(0),accessibility:amount(0),
  maintenance:maintenance===null?null:amount(maintenance),replacement:amount(300_000),interval:8,replacementPlan:'scheduled',
  source:`Illustrative costs for the ${pilot.neighborhood} demo`,
});

// Fictional sites in several Forest Hills blocks. Coordinates place scenario markers, not verified facilities.
export const demoParks=[
  ['demo-west',`${pilot.neighborhood} West demo area`,40.7190,-73.8500],
  ['demo-east',`${pilot.neighborhood} East demo area`,40.7180,-73.8415],
  ['demo-north',`${pilot.neighborhood} North demo area`,40.7252,-73.8502],
  ['demo-south',`${pilot.neighborhood} South demo area`,40.7140,-73.8451],
  ['demo-v3-west-commons','West commons demo area',40.7242,-73.8710],
  ['demo-v3-west-court','West paved court demo area',40.7265,-73.8746],
  ['demo-v3-east-gate','East gate demo area',40.7331,-73.8298],
  ['demo-v3-east-green','East green demo area',40.7300,-73.8345],
] as const;

export const demoEquipment=[
  ['demo-bars','West court pull-up bars','pull-up',40.7190,-73.8500,'demo-west','usable','public',true],
  ['demo-parallel','East court parallel bars','parallel',40.7180,-73.8415,'demo-east','unknown','unknown',false],
  ['demo-bench','Standalone sit-up bench','sit-up',40.7179,-73.8450,null,'unknown','unknown',false],
  ['demo-north-bars','North green pull-up bars','pull-up',40.7252,-73.8502,'demo-north','usable','public',true],
  ['demo-rail','Courtyard wall bars','pull-up',40.7204,-73.8451,null,'unusable','public',true],
  ['demo-east-bars','East terrace pull-up bars','pull-up',40.7182,-73.8402,'demo-east','usable','restricted',true],
  ['demo-west-rail','West walk parallel bars','parallel',40.72015,-73.85075,'demo-west','usable','public',true],
  ['demo-south-rail','South green parallel bars','parallel',40.71425,-73.84542,'demo-south','usable','public',true],
  ['demo-grove-rail','Grove parallel bars','parallel',40.7234,-73.8489,null,'unusable','public',true],
  ['demo-crossing-rail','Corner parallel bars','parallel',40.7221,-73.8428,null,'unknown','unknown',false],
  ['demo-north-bench','North green sit-up bench','sit-up',40.7250,-73.8504,'demo-north','usable','public',true],
  ['demo-west-bench','West court sit-up bench','sit-up',40.7192,-73.8498,'demo-west','usable','public',true],
  ['demo-east-bench','East terrace sit-up bench','sit-up',40.71835,-73.8409,'demo-east','unusable','public',true],
  ['demo-south-bench','South green sit-up bench','sit-up',40.7144,-73.8452,'demo-south','usable','public',false],
  ['demo-walk-bench','Garden walk sit-up bench','sit-up',40.7208,-73.8422,null,'usable','unknown',false],
  ['demo-v3-west-bollard','West commons pull-up frame','pull-up',40.7237,-73.8713,'demo-v3-west-commons','unusable','public',true],
  ['demo-v3-west-sport','West field pull-up bars','pull-up',40.7207,-73.8724,null,'usable','public',true],
  ['demo-v3-west-pad-bar','West paved court pull-up bars','pull-up',40.7270,-73.8752,'demo-v3-west-court','unknown','unknown',false],
  ['demo-v3-west-rail','West boundary parallel bars','parallel',40.7249,-73.8705,'demo-v3-west-commons','usable','public',true],
  ['demo-v3-west-rail-pair','West practice parallel bars','parallel',40.7268,-73.8748,'demo-v3-west-court','usable','restricted',true],
  ['demo-v3-west-pad-bench','West paved court sit-up bench','sit-up',40.7261,-73.8741,'demo-v3-west-court','usable','public',false],
  ['demo-v3-west-field-bench','West field sit-up bench','sit-up',40.7211,-73.8736,null,'usable','public',true],
  ['demo-v3-east-court-bar','East gate pull-up bars','pull-up',40.7333,-73.8306,'demo-v3-east-gate','usable','restricted',true],
  ['demo-v3-east-path-bar','East green pull-up station','pull-up',40.7292,-73.8351,'demo-v3-east-green','usable','public',true],
  ['demo-v3-east-court-rail','East gate parallel bars','parallel',40.7334,-73.8290,'demo-v3-east-gate','unusable','public',true],
  ['demo-v3-east-green-rail','East green parallel bars','parallel',40.7298,-73.8341,'demo-v3-east-green','usable','public',true],
  ['demo-v3-east-rail-island','East path parallel bars','parallel',40.7279,-73.8332,null,'unknown','unknown',false],
  ['demo-v3-east-court-bench','East gate sit-up bench','sit-up',40.7330,-73.8294,'demo-v3-east-gate','usable','public',true],
  ['demo-v3-east-lawn-bench','East green sit-up bench','sit-up',40.7302,-73.8340,'demo-v3-east-green','unknown','public',false],
] as const;

export const demoCandidates=[
  ['demo-a','Central courtyard A','pull-up',40.71935,-73.84675,null,'suitable-for-comparison',
    profile(700_000,500_000,40_000),'Confirm site preparation and accessibility with field staff.'],
  ['demo-b','Central courtyard B','pull-up',40.71918,-73.84370,null,'suitable-for-comparison',
    profile(900_000,600_000,50_000),'Confirm ownership and site conditions.'],
  ['demo-pull-premium','South garden pull-up area','pull-up',40.7147,-73.8475,'demo-south','unreviewed',
    profile(1_500_000,870_000,null),'Higher site cost. Annual maintenance is unknown.'],
  ['demo-pull-distant','North walk pull-up area','pull-up',40.7280,-73.8518,null,'suitable-for-comparison',
    profile(740_000,480_000,35_000),'Illustrates a site with no matching recorded demand at the default radius.'],
  ['demo-c','East exercise station','parallel',40.7188,-73.8420,'demo-east','unreviewed',
    profile(650_000,520_000,42_000),'Feasibility review remains open.'],
  ['demo-parallel-grove','Grove parallel bars option','parallel',40.7237,-73.8476,null,'suitable-for-comparison',
    profile(640_000,470_000,36_000),'Models coverage of the grove cluster.'],
  ['demo-sit-east','East garden bench option','sit-up',40.7190,-73.8419,'demo-east','suitable-for-comparison',
    profile(330_000,420_000,24_000),'Models coverage near the east garden.'],
  ['demo-sit-excluded','South corner bench option','sit-up',40.71485,-73.84575,'demo-south','excluded',
    profile(250_000,270_000,15_000),'Excluded from combinations for this scenario.'],
  ['demo-v3-west-pad','West paved court conversion','pull-up',40.7265,-73.8746,'demo-v3-west-court','suitable-for-comparison',
    profile(590_000,460_000,38_000),'Bolt onto existing slab. No excavation, tree work or path closures. Delivery booking pending.'],
  ['demo-v3-west-program','West commons recreation station','pull-up',40.7242,-73.8709,'demo-v3-west-commons','suitable-for-comparison',
    profile(1_010_000,790_000,55_000),'New footings and a phased path closure. This catchment has few eligible pull-up listings.'],
  ['demo-v3-east-gate-candidate','East gate training plaza','pull-up',40.7331,-73.8298,'demo-v3-east-gate','suitable-for-comparison',
    profile(880_000,720_000,45_000),'Materials allocated, inspection slot and delivery window confirmed. Trenching requires a path detour.'],
  ['demo-v3-west-parallel','West hardcourt rail layout','parallel',40.7262,-73.8739,'demo-v3-west-court','suitable-for-comparison',
    profile(560_000,470_000,34_000),'Surface-mount on existing pavement. Confirm final equipment clearance before ordering.'],
  ['demo-v3-east-parallel','East gate rail extension','parallel',40.7332,-73.8303,'demo-v3-east-gate','unreviewed',
    profile(680_000,640_000,null),'Utility clearance and annual maintenance estimate are missing.'],
  ['demo-v3-west-sit','West commons bench station','sit-up',40.7244,-73.8714,'demo-v3-west-commons','excluded',
    profile(310_000,390_000,24_000),'Proposed pad conflicts with the delivery and emergency-access corridor in this scenario.'],
  ['demo-v3-east-sit','East green bench retrofit','sit-up',40.7302,-73.8347,'demo-v3-east-green','suitable-for-comparison',
    profile(320_000,420_000,23_000),'Existing pad can be reused. Materials and unloading access identified. Installation date pending.'],
] as const;

// Small blocks with different densities and bearings, using local offsets in metres.
const originalClusters=[
  ['pull-up',40.71905,-73.8500,8,72,46,.4],
  ['pull-up',40.71955,-73.84745,12,90,57,.55],
  ['pull-up',40.71913,-73.84515,12,74,42,-.4],
  ['pull-up',40.71950,-73.84275,8,65,48,.46],
  ['pull-up',40.71478,-73.84747,4,118,60,.65],
  ['pull-up',40.72542,-73.85398,3,125,58,-.55],
  ['parallel',40.71866,-73.84224,6,110,54,-.4],
  ['parallel',40.72356,-73.84770,7,105,58,.6],
  ['parallel',40.71427,-73.84532,5,105,46,-.35],
  ['sit-up',40.71902,-73.84140,7,113,66,.7],
  ['sit-up',40.72494,-73.85022,5,110,52,.35],
  ['sit-up',40.71633,-73.85220,4,126,58,-.55],
] as const;
const addedClusters=[
  ['pull-up',40.72419,-73.87082,27,125,75,.65],
  ['pull-up',40.72657,-73.87478,7,93,62,-.32],
  ['pull-up',40.73311,-73.82965,11,105,85,.49],
  ['pull-up',40.72941,-73.83531,4,67,53,.2],
  ['parallel',40.72615,-73.87396,5,96,75,-.4],
  ['parallel',40.73320,-73.83020,6,126,69,.6],
  ['sit-up',40.72436,-73.87163,4,73,62,.3],
  ['sit-up',40.73014,-73.83477,8,120,90,-.58],
] as const;

export function demoDemand() {
  let state=0x476f7265;
  const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  return [...originalClusters,...addedClusters].flatMap(([category,lat,lng,count,width,height,angle],group)=>Array.from({length:count},(_,index)=>{
    const distance=Math.sqrt(random());
    const direction=random()*Math.PI*2;
    const x=width*distance*Math.cos(direction);
    const y=height*distance*Math.sin(direction);
    return {
      id:`demo-v${group<originalClusters.length?2:3}-demand-${group}-${index}`,category,
      lat:Number((lat+(x*Math.sin(angle)+y*Math.cos(angle))/111195).toFixed(6)),
      lng:Number((lng+(x*Math.cos(angle)-y*Math.sin(angle))/84300).toFixed(6)),
    };
  }));
}

export const legacyDemandIds=Array.from({length:25},(_,index)=>`demo-demand-${index}`);

export const demoTypeProposals=[
  ['demo-type-balance','Balance rails','Local demo · Approve this as a new type.'],
  ['demo-type-platform','Step-up platfroms','Local demo · Correct the spelling to “Step-up platforms” before approving.'],
  ['demo-type-match','Chin-up frames','Local demo · Use the existing Pull-up bars type.'],
] as const;

// Fixed dates keep the illustrative planning scenario reproducible.
export const demoGoalSchedule={earliestStart:'2027-03-01',targetCompletion:'2027-06-30'};
export const previousDemoProgramGoals=[
  {id:'demo-goal-low-disruption',name:'Low disruption',
    description:'Favor supplied evidence of straightforward installation with limited disturbance. Flag unresolved ground and access concerns.',
    ...demoGoalSchedule,allowedTypes:[]},
  {id:'demo-goal-delivery',name:'Delivery readiness',
    description:'Favor documented feasibility and fewer unresolved delivery issues. Missing notes do not demonstrate readiness.',
    earliestStart:null,targetCompletion:null,allowedTypes:[]},
  {id:'demo-goal-program',name:'Pull-up recreation program',
    description:'Favor pull-up stations with documented straightforward installation and coverage of recorded unmet requests.',
    earliestStart:null,targetCompletion:null,allowedTypes:['pull-up']},
] as const;
const [disruption,delivery,program]=previousDemoProgramGoals;
export const demoProgramGoals=[
  {...disruption,description:'Prioritize avoiding excavation, tree removal and closures of public routes. Favor explicit evidence of using an existing pad and keeping paths open. Delivery readiness is secondary.'},
  {...delivery,description:'Prioritize delivery by the entered target. Favor explicit confirmations of materials, staging, and inspection or utility readiness. Planned temporary detours can be acceptable.',
    targetCompletion:'2027-05-31'},
  {...program,description:'Prioritize reaching more currently unmet pull-up requests. Compare the recorded newly covered counts across options. Closures or more complex installation may be worthwhile for substantially greater reach.'},
] as const;
export const demoGoalCandidateUpdates=[
  ['demo-a','Surface-mounted install on an existing pad. The staging route is identified in this fictional scenario.',
    demoGoalSchedule.earliestStart,'2027-05-15'],
  ['demo-b','Existing paved pad reduces ground disturbance. Delivery access and clearance need confirmation.',
    '2027-02-15','2027-07-12'],
  ['demo-pull-distant','Excavation and temporary path closure would be needed in this fictional scenario.',
    '2027-04-15','2027-06-20'],
] as const;
export const addedDemoGoalSchedules=[
  ['demo-v3-west-pad','2027-04-26','2027-06-09'],
  ['demo-v3-west-program','2027-04-05','2027-06-24'],
  ['demo-v3-east-gate-candidate','2027-03-22','2027-05-06'],
  ['demo-v3-west-parallel','2027-04-12','2027-05-24'],
] as const;
