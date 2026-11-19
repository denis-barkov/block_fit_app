import { pilot } from './settings.ts';

export const demoVersion=2;
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
] as const;

// Small blocks with different densities and bearings, using local offsets in metres.
const clusters=[
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

export function demoDemand() {
  let state=0x476f7265;
  const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  return clusters.flatMap(([category,lat,lng,count,width,height,angle],group)=>Array.from({length:count},(_,index)=>{
    const distance=Math.sqrt(random());
    const direction=random()*Math.PI*2;
    const x=width*distance*Math.cos(direction);
    const y=height*distance*Math.sin(direction);
    return {
      id:`demo-v2-demand-${group}-${index}`,category,
      lat:Number((lat+(x*Math.sin(angle)+y*Math.cos(angle))/111195).toFixed(6)),
      lng:Number((lng+(x*Math.cos(angle)-y*Math.sin(angle))/84300).toFixed(6)),
    };
  }));
}

export const legacyDemandIds=Array.from({length:25},(_,index)=>`demo-demand-${index}`);
