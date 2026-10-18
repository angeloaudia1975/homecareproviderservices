// Dealer 360 organization navigation uses only server-authorized dealer rows.
(function(root, factory){
  const api=factory();
  if(typeof module==="object" && module.exports) module.exports=api;
  if(root) root.HCPSDealerFamily=api;
})(typeof window!=="undefined"?window:null,function(){
  const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  function linksFor(current,accessible){
    if(!current||!current.id)return null;
    const visible=(accessible||[]).filter(d=>d&&d.id);
    const rootId=String(current.parent_id||current.id);
    const headquarters=visible.find(d=>String(d.id)===rootId)||null;
    const branches=visible.filter(d=>String(d.parent_id||"")===rootId && String(d.id)!==rootId)
      .sort((a,b)=>String(a.name||"").localeCompare(String(b.name||""))||String(a.id).localeCompare(String(b.id)));
    if(!branches.length && !(current.parent_id&&headquarters))return null;
    return {headquarters,branches,isHeadquarters:!current.parent_id};
  }
  function render(current,accessible){
    const group=linksFor(current,accessible); if(!group)return "";
    const item=d=>{
      const selected=String(d.id)===String(current.id);
      const name=esc(d.name||"Unnamed location"),acct=esc(d.hcps_account||"—");
      const place=esc([d.city,d.state].filter(Boolean).join(", "));
      const inner='<span class="family-location-name">'+name+
        (d.active===false?' <span class="family-inactive">Inactive</span>':"")+
        (selected?' <span class="family-current">Current</span>':"")+
        '</span><span class="family-location-meta">HCPS # '+acct+(place?' · '+place:"")+'</span>';
      return selected?'<span class="family-location family-selected" aria-current="page">'+inner+'</span>'
        :'<a class="family-location" href="/admin/dealer.html?id='+encodeURIComponent(String(d.id))+'" title="Open branch profile">'+inner+'</a>';
    };
    const cards=[];
    if(!group.isHeadquarters&&group.headquarters)cards.push(item(group.headquarters));
    for(const d of group.branches)cards.push(item(d));
    return '<nav class="family-nav" aria-label="Linked headquarters and branch locations">'+
      '<div class="family-nav-title">🏢 '+(group.isHeadquarters?'Branch locations':'Headquarters &amp; branch locations')+
      ' <span class="family-nav-count">('+group.branches.length+' accessible branch'+(group.branches.length===1?'':'es')+')</span></div>'+
      '<div class="family-nav-items">'+cards.join("")+'</div></nav>';
  }
  return {linksFor,render};
});