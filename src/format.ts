const currency=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'});
const newYork={timeZone:'America/New_York'} as const;
const date=new Intl.DateTimeFormat('en-US',{...newYork,dateStyle:'medium'});
const dateTime=new Intl.DateTimeFormat('en-US',{...newYork,dateStyle:'medium',timeStyle:'short'});

export const dollars=(cents:number|null)=>cents===null?'N/A':currency.format(cents/100);
function formatTimestamp(timestamp:string,formatter:Intl.DateTimeFormat) {
  const value=new Date(/^\d{4}-\d{2}-\d{2}$/.test(timestamp)?timestamp+'T12:00:00Z':timestamp);
  return Number.isNaN(value.getTime())?'Unknown':formatter.format(value);
}
export const localDate=(timestamp:string)=>formatTimestamp(timestamp,date);
export const localDateTime=(timestamp:string)=>formatTimestamp(timestamp,dateTime);
