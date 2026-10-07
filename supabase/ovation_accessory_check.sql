-- Ovation: where do the shared/colliding part numbers sit today? Read-only.
-- 1) Which enrichment pages list each code in their SKU list
select s.code, pc.page_key, pc.name, pc.status
from (values ('61000-2'),('62007'),('61008-2'),('51500'),('51508'),('51600'),('51608')) s(code)
join product_content pc
  on pc.manufacturer = 'ovation-medical'
 and exists (select 1 from jsonb_array_elements(pc.skus) x
             where upper(trim(coalesce(x->>'sku', x->>'code'))) = s.code)
order by s.code, pc.page_key;

-- 2) Which of them are already linked as Related products, and from which parent
select related_code, code as parent_code, kind
from product_related
where manufacturer = 'ovation-medical'
  and upper(trim(related_code)) in ('61000-2','62007','61008-2','51500','51508','51600','51608')
order by related_code, code;
