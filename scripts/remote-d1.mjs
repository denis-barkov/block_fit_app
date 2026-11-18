// The D1 administrative REST API takes string parameters. JSON round-tripping
// preserves SQLite numeric and NULL types when sending parameters to that API.
export function remoteDatabase(call,id) {
  const path=`/d1/database/${id}/query`;
  const execute=async batch=>{
    const result=await call(path,'POST',{batch});
    if (!Array.isArray(result)||result.length!==batch.length||result.some(entry=>!entry.success)) {
      throw new Error('The D1 administrative query did not complete.');
    }
    return result;
  };
  class Statement {
    constructor(sql,params=[]){this.sql=sql;this.params=params;}
    bind(...params) {return new Statement(this.sql,params);}
    data() {
      return {sql:this.sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|\?/g,
          fragment=>fragment==='?'?"json_extract(?, '$')":fragment),
        params:this.params.map(value=>JSON.stringify(value))};
    }
    async all() {return (await execute([this.data()]))[0];}
    async first(column) {
      const row=(await this.all()).results[0];
      return column ? row?.[column]??null : row??null;
    }
    async raw() {return (await this.all()).results.map(row=>Object.values(row));}
    async run(){return this.all();}
  }
  return {
    prepare:sql=>new Statement(sql),
    exec:async sql=>execute([{sql}]),

    batch:statements=>execute(statements.map(statement=>statement.data())),
  };
}
