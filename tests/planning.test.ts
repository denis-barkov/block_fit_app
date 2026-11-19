import { describe,expect,it } from 'vitest';
import { calculateCosts,compare,makeBrief,metres,type Comparison,type DemandOrigin } from '../src/server/planning';
import { comparisonSnapshot } from '../src/server/ai-comparison';
import type {Candidate,Costs,Scenario} from '../src/contracts';

const amount=(base:number)=>({low:base,base,high:base});
function cost(upfront:number,maintenance:number): Costs {
  return {equipment:amount(upfront),installation:amount(0),preparation:amount(0),accessibility:amount(0),
    maintenance:amount(maintenance),replacement:amount(300_000),interval:8,replacementPlan:'scheduled',source:'Illustrative'};
}
const coordinate=(m:number)=>({lat:0,lng:m/111195});
const origin=(id:string,m:number): DemandOrigin=>({...coordinate(m),id,synthetic:true});
const categoryName='Pull-up bars';
const site=(id:string,m:number,costs:Costs): Candidate=>({...coordinate(m),category:'pull-up',categoryName,categoryActive:true,id,name:id,
  feasibility:'suitable-for-comparison',parkId:null,projectUrl:null,notes:'',costs});
const a=site('A',450,cost(1_200_000,40_000)), b=site('B',740,cost(1_500_000,50_000));
const sample=[origin('covered',0),origin('a-only',330),origin('both',590),origin('b-only',850)];
const scenario:Scenario={category:'pull-up',radius:200,budget:2_000_000,horizon:10,selected:['A','B']};

describe('investment comparisons',()=>{
  it('evaluates unique overlap, lifecycle costs and upfront budgets independently',()=>{
    const result=compare(scenario,sample,[coordinate(0)],[a,b])!;
    expect(result.unmet).toBe(3);
    expect(result.options.map(x=>x.count)).toEqual([2,2,3]);
    expect(result.options.map(x=>x.estimates.base.upfront)).toEqual([1_200_000,1_500_000,2_700_000]);
    expect(result.options.map(x=>x.estimates.base.lifecycle)).toEqual([1_900_000,2_300_000,4_200_000]);
    expect(result.options.map(x=>x.estimates.base.fits)).toEqual([true,true,false]);
    expect(result.highlighted).toEqual(['A']);
  });
  it('includes exact-radius origins and counts replacement strictly before the horizon',()=>{
    const originAtBoundary=origin('edge',650);
    const result=compare({...scenario,selected:[],radius:metres(a,originAtBoundary)},[originAtBoundary],[],[a]);
    expect(result?.options[0].count).toBe(1);
    expect([8,9,16,17].map(h=>calculateCosts(a.costs,h,'base').events)).toEqual([0,1,1,2]);
    expect(calculateCosts({...a.costs,replacement:null,replacementPlan:'none'},10,'base').replacementTotal).toBe(0);
  });
  it('preserves missing amounts, excludes provisional and excluded records, handles zero coverage and ties',()=>{
    const unknown={...a,costs:{...a.costs,maintenance:null}};
    const result=compare({...scenario,selected:[]},[],[],[unknown])!;
    expect(result.options[0].estimates.base).toMatchObject({upfront:1_200_000,fits:true,lifecycle:null,perRequester:null});
    expect(result.highlighted).toEqual([]);
    const excluded={...b,feasibility:'excluded' as const};
    expect(compare(scenario,sample,[],[a,excluded])).toBeNull();
    const identical={...a,id:'other'};
    const provisional={...a,id:'provisional',feasibility:'unreviewed' as const};
    expect(compare({...scenario,selected:[]},sample,[],[a,identical,provisional,excluded])?.highlighted).toEqual(['A','other']);
  });
  it('exports revision and sanitized site content with no private origins',()=>{
    const site={...a,name:'# Heading\n<img src=x>',notes:'<script>alert(1)</script>'};
    const results=compare({...scenario,selected:[]},sample,[],[site])!;
    const comparison:Comparison={...results,scenario:{...scenario,selected:[]},categoryName,revision:8,calculatedAt:'2026-11-18T00:00:00.000Z',
      sites:[site],origins:[{lng:1.23456789,lat:12.3456789,synthetic:false}],existing:[],inventorySources:['Demo']};
    const output=makeBrief(comparison);
    expect(output).toContain('Revision: 8');
    expect(output).toContain('Replacement plan: scheduled');
    expect(output).not.toContain('<script>');
    expect(output).not.toContain('12.3456789');
  });
});

describe('AI comparison snapshot',()=>{
  function snapshot(candidates:Candidate[], selected:string[]=[]){
    const input={...scenario,selected};
    const existing=[{...coordinate(0),fixture:true}];
    const result=compare(input,sample,existing,candidates)!;
    return comparisonSnapshot({...result,scenario:input,categoryName,revision:8,calculatedAt:'2026-11-18T00:00:00.000Z',
      sites:candidates,origins:sample,existing,inventorySources:['Demo']});
  }
  it('sends computed equal-coverage tradeoffs, union, cost ranges and budget fit without individual details',()=>{
    const labelA={...a,name:'First courtyard',notes:'confidential fixture',fixture:true};
    const labelB={...b,name:'Second courtyard',fixture:true};
    const result=snapshot([labelA,labelB],['A','B']);
    expect(result).toMatchObject({
      scenario:{area:'Brooklyn and Queens',horizonYears:10,radiusMetres:200,upfrontBudget:'$20,000',
        upfrontBudgetMinorUnits:2_000_000,demandData:'synthetic',inventoryData:'synthetic',candidateData:'synthetic'},
      demand:{eligibleUniqueActiveRequesters:4,alreadyServed:1,baselineUnmet:3},
      costs:{currency:'USD',internalUnit:'cents',rangeOrder:['low','base','high']},
      ranking:{highlightedOptionIds:['A'],tied:false},
    });
    const option=(id:string)=>result.options.find(option=>option.id===id);
    expect(option('A')).toMatchObject({name:'First courtyard',newlyCovered:2,upfront:['$12,000','$12,000','$12,000'],
      lifecycle:['$19,000','$19,000','$19,000'],baseLifecyclePerNewRequester:'$9,500',highlightEligible:true});
    expect(option('B')).toMatchObject({newlyCovered:2,baseLifecyclePerNewRequester:'$11,500'});
    expect(option('A,B')).toMatchObject({type:'combination',siteIds:['A','B'],newlyCovered:3,overlap:1,
      fitsUpfrontBudget:[false,false,false],highlightEligible:false});
    expect(snapshot([labelA,labelB],['B','A'])).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(/confidential fixture|a-only|b-only|"lat"|"lng"/);
  });

  it('distinguishes zero coverage, missing maintenance, low-only budget fit, redundant coverage and exact ties',()=>{
    const identical={...a,id:'T',name:'Same rate'};
    const zero=site('Z',2000,cost(900_000,30_000));
    const unknown=site('U',450,{...a.costs,maintenance:null});
    const lowOnly=site('L',450,{...a.costs,equipment:{low:1_000_000,base:2_100_000,high:2_500_000}});
    const result=snapshot([a,identical,zero,unknown,lowOnly],['A','T']);
    expect(result.ranking).toMatchObject({highlightedOptionIds:['A','T'],tied:true});
    const option=(id:string)=>result.options.find(option=>option.id===id);
    expect(option('A,T')).toMatchObject({newlyCovered:2,overlap:2,upfront:['$24,000','$24,000','$24,000']});
    expect(option('Z')).toMatchObject({newlyCovered:0,sufficientCostData:true,perRequesterUnavailable:'no additional coverage'});
    expect(option('U')).toMatchObject({sufficientCostData:false,lifecycle:[null,null,null],missing:['maintenance'],
      perRequesterUnavailable:'incomplete lifecycle cost'});
    expect(option('L')).toMatchObject({fitsUpfrontBudget:[true,false,false],highlightExclusions:['base upfront cost exceeds budget']});
    expect(snapshot([zero,unknown,lowOnly]).ranking).toMatchObject({highlightedOptionIds:[],tied:false});
  });
});
