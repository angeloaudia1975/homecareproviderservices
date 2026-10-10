-- ============================================================================
-- MI-1a · DRY RUN — READ ONLY (SELECT only). Changes nothing.
-- The Supabase SQL editor shows only the LAST result, so run each query on its own.
-- The proposed key uses exactly the expressions in hcps_ms_order_part / hcps_ms_sku_part.
-- ============================================================================

-- D0. Live column types the migration relies on.
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'monthly_sales'
  and column_name in ('id','dealer_id','manufacturer','period','order_date','invoice_no','product_code','product_name',
                      'qty','amount','commission','commission_rate','source','external_ref','source_file','imported_at',
                      'batch_id','order_key','line_key','line_hash')
order by column_name;

-- D1. Scope per manufacturer (Strongback expected: 143 rows, $43,021.50).
with k as (
  select m.*,
         case when nullif(upper(regexp_replace(btrim(coalesce(m.invoice_no,'')), '\s+', '', 'g')),'') is not null
                then 'O:' || upper(regexp_replace(btrim(m.invoice_no), '\s+', '', 'g'))
              else 'NOORDER:' || coalesce(m.order_date::text, m.period::text, '?') || ':'
                   || left(upper(regexp_replace(coalesce(m.customer_name,''), '[^A-Za-z0-9]', '', 'g')), 40) end as k_order,
         left(upper(regexp_replace(btrim(coalesce(nullif(btrim(m.product_code),''), m.product_name, '')), '\s+', ' ', 'g')), 80) as k_sku
  from monthly_sales m where m.source = 'sales_report'
), p as (
  select k.*, row_number() over (partition by manufacturer, k_order, k_sku
              order by qty asc nulls first, amount asc nulls first, coalesce(product_name,''), order_date nulls first, id) as k_n
  from k
), mi1a_proposed as (
  select p.*, manufacturer || '|v2|' || k_order || '|' || k_sku || '|' || k_n as new_external_ref from p
)
select manufacturer, count(*) as rows, sum(amount) as sales, sum(commission) as commission,
       min(period) as first_month, max(period) as last_month,
       count(*) filter (where k_order like 'NOORDER:%') as rows_without_order_no,
       count(*) filter (where k_sku = '') as rows_without_sku_or_name,
       count(*) filter (where dealer_id is null) as unmatched_rows
from mi1a_proposed group by manufacturer order by manufacturer;

-- D2. Key collisions — must return ZERO rows.
with k as (
  select m.*,
         case when nullif(upper(regexp_replace(btrim(coalesce(m.invoice_no,'')), '\s+', '', 'g')),'') is not null
                then 'O:' || upper(regexp_replace(btrim(m.invoice_no), '\s+', '', 'g'))
              else 'NOORDER:' || coalesce(m.order_date::text, m.period::text, '?') || ':'
                   || left(upper(regexp_replace(coalesce(m.customer_name,''), '[^A-Za-z0-9]', '', 'g')), 40) end as k_order,
         left(upper(regexp_replace(btrim(coalesce(nullif(btrim(m.product_code),''), m.product_name, '')), '\s+', ' ', 'g')), 80) as k_sku
  from monthly_sales m where m.source = 'sales_report'
), p as (
  select k.*, row_number() over (partition by manufacturer, k_order, k_sku
              order by qty asc nulls first, amount asc nulls first, coalesce(product_name,''), order_date nulls first, id) as k_n
  from k
), mi1a_proposed as (
  select p.*, manufacturer || '|v2|' || k_order || '|' || k_sku || '|' || k_n as new_external_ref from p
)
select manufacturer, new_external_ref, count(*) from mi1a_proposed group by 1,2 having count(*) > 1;

-- D3. New keys already used as an old key — must return ZERO rows.
with k as (
  select m.*,
         case when nullif(upper(regexp_replace(btrim(coalesce(m.invoice_no,'')), '\s+', '', 'g')),'') is not null
                then 'O:' || upper(regexp_replace(btrim(m.invoice_no), '\s+', '', 'g'))
              else 'NOORDER:' || coalesce(m.order_date::text, m.period::text, '?') || ':'
                   || left(upper(regexp_replace(coalesce(m.customer_name,''), '[^A-Za-z0-9]', '', 'g')), 40) end as k_order,
         left(upper(regexp_replace(btrim(coalesce(nullif(btrim(m.product_code),''), m.product_name, '')), '\s+', ' ', 'g')), 80) as k_sku
  from monthly_sales m where m.source = 'sales_report'
), p as (
  select k.*, row_number() over (partition by manufacturer, k_order, k_sku
              order by qty asc nulls first, amount asc nulls first, coalesce(product_name,''), order_date nulls first, id) as k_n
  from k
), mi1a_proposed as (
  select p.*, manufacturer || '|v2|' || k_order || '|' || k_sku || '|' || k_n as new_external_ref from p
)
select p.manufacturer, p.new_external_ref from mi1a_proposed p
join monthly_sales m on m.manufacturer = p.manufacturer and m.external_ref = p.new_external_ref and m.id <> p.id;

-- D4. Suspected duplicates (same order + SKU + qty + amount held more than once).
with k as (
  select m.*,
         case when nullif(upper(regexp_replace(btrim(coalesce(m.invoice_no,'')), '\s+', '', 'g')),'') is not null
                then 'O:' || upper(regexp_replace(btrim(m.invoice_no), '\s+', '', 'g'))
              else 'NOORDER:' || coalesce(m.order_date::text, m.period::text, '?') || ':'
                   || left(upper(regexp_replace(coalesce(m.customer_name,''), '[^A-Za-z0-9]', '', 'g')), 40) end as k_order,
         left(upper(regexp_replace(btrim(coalesce(nullif(btrim(m.product_code),''), m.product_name, '')), '\s+', ' ', 'g')), 80) as k_sku
  from monthly_sales m where m.source = 'sales_report'
), p as (
  select k.*, row_number() over (partition by manufacturer, k_order, k_sku
              order by qty asc nulls first, amount asc nulls first, coalesce(product_name,''), order_date nulls first, id) as k_n
  from k
), mi1a_proposed as (
  select p.*, manufacturer || '|v2|' || k_order || '|' || k_sku || '|' || k_n as new_external_ref from p
)
select manufacturer, k_order, k_sku, qty, amount, count(*) as copies,
       count(distinct coalesce(source_file,'?')) as files, count(distinct imported_at) as import_times,
       array_agg(distinct source_file) as source_files, sum(amount) as amount_held,
       case when count(distinct coalesce(source_file,'?')) > 1 or count(distinct imported_at) > 1
            then 'LIKELY RE-IMPORT DUPLICATE' else 'repeated line on one order' end as verdict
from mi1a_proposed group by 1,2,3,4,5 having count(*) > 1
order by verdict, manufacturer, k_order;

-- D5. Strongback — every row with its proposed key (review list).
with k as (
  select m.*,
         case when nullif(upper(regexp_replace(btrim(coalesce(m.invoice_no,'')), '\s+', '', 'g')),'') is not null
                then 'O:' || upper(regexp_replace(btrim(m.invoice_no), '\s+', '', 'g'))
              else 'NOORDER:' || coalesce(m.order_date::text, m.period::text, '?') || ':'
                   || left(upper(regexp_replace(coalesce(m.customer_name,''), '[^A-Za-z0-9]', '', 'g')), 40) end as k_order,
         left(upper(regexp_replace(btrim(coalesce(nullif(btrim(m.product_code),''), m.product_name, '')), '\s+', ' ', 'g')), 80) as k_sku
  from monthly_sales m where m.source = 'sales_report'
), p as (
  select k.*, row_number() over (partition by manufacturer, k_order, k_sku
              order by qty asc nulls first, amount asc nulls first, coalesce(product_name,''), order_date nulls first, id) as k_n
  from k
), mi1a_proposed as (
  select p.*, manufacturer || '|v2|' || k_order || '|' || k_sku || '|' || k_n as new_external_ref from p
)
select id, period, order_date, invoice_no, product_code, qty, amount, commission, dealer_id, source_file,
       external_ref as old_external_ref, new_external_ref
from mi1a_proposed where manufacturer = 'strongback-mobility' order by order_date, k_order, k_sku, k_n;

-- D6. Months already holding a commission statement (future corrections there need approval).
with k as (
  select m.*,
         case when nullif(upper(regexp_replace(btrim(coalesce(m.invoice_no,'')), '\s+', '', 'g')),'') is not null
                then 'O:' || upper(regexp_replace(btrim(m.invoice_no), '\s+', '', 'g'))
              else 'NOORDER:' || coalesce(m.order_date::text, m.period::text, '?') || ':'
                   || left(upper(regexp_replace(coalesce(m.customer_name,''), '[^A-Za-z0-9]', '', 'g')), 40) end as k_order,
         left(upper(regexp_replace(btrim(coalesce(nullif(btrim(m.product_code),''), m.product_name, '')), '\s+', ' ', 'g')), 80) as k_sku
  from monthly_sales m where m.source = 'sales_report'
), p as (
  select k.*, row_number() over (partition by manufacturer, k_order, k_sku
              order by qty asc nulls first, amount asc nulls first, coalesce(product_name,''), order_date nulls first, id) as k_n
  from k
), mi1a_proposed as (
  select p.*, manufacturer || '|v2|' || k_order || '|' || k_sku || '|' || k_n as new_external_ref from p
)
select distinct p.manufacturer, to_char(p.period,'YYYY-MM') as month
from mi1a_proposed p
where exists (select 1 from monthly_sales s where s.manufacturer = p.manufacturer and s.period = p.period and s.source = 'commission')
order by 1,2;

-- D7. Baseline totals for the before/after reconciliation (save this output).
select manufacturer, coalesce(source,'(none)') as source, to_char(period,'YYYY-MM') as month,
       count(*) as rows, sum(amount) as sales, sum(commission) as commission
from monthly_sales group by 1,2,3 order by 1,2,3;

-- D8. Identity audit: invoice numbers that recur across customers, months or files (sales_report rows).
--     COLLISION = different customer refs, or order dates more than 31 days apart -> blocks enrolment.
--     REVIEW    = different customer names only (spelling or a real second customer?).
--     INFO      = the same order seen in more than one file (normal for overlapping YTD exports).
select manufacturer, invoice_no,
       count(*) as lines, count(distinct coalesce(source_file,'?')) as files,
       count(distinct upper(btrim(customer_ref))) filter (where customer_ref is not null) as customer_refs,
       count(distinct upper(regexp_replace(coalesce(customer_name,''),'[^A-Za-z0-9]','','g'))) as customer_names,
       min(order_date) as first_date, max(order_date) as last_date, count(distinct period) as months,
       array_agg(distinct customer_name) as names, sum(amount) as amount,
       case when count(distinct upper(btrim(customer_ref))) filter (where customer_ref is not null) > 1
              or max(order_date) - min(order_date) > 31 then 'COLLISION'
            when count(distinct upper(regexp_replace(coalesce(customer_name,''),'[^A-Za-z0-9]','','g'))) > 1 then 'REVIEW'
            else 'INFO' end as verdict
from monthly_sales
where source = 'sales_report' and nullif(btrim(coalesce(invoice_no,'')),'') is not null
group by manufacturer, invoice_no
having count(distinct upper(btrim(customer_ref))) filter (where customer_ref is not null) > 1
    or max(order_date) - min(order_date) > 31
    or count(distinct upper(regexp_replace(coalesce(customer_name,''),'[^A-Za-z0-9]','','g'))) > 1
    or count(distinct coalesce(source_file,'?')) > 1
order by verdict, manufacturer, invoice_no;

-- D9. Historical commission statements: manufacturer-months holding more than one file, with
--     identical or overlapping content (possible duplicates already in the books, pre-MI-1a).
with f as (
  select manufacturer, period, coalesce(source_file,'(no file name)') as file, count(*) as rows,
         sum(amount) as amount, sum(commission) as commission,
         md5(string_agg(concat_ws('|', upper(regexp_replace(coalesce(customer_name,''),'[^A-Za-z0-9]','','g')), upper(btrim(coalesce(invoice_no,''))),
             upper(btrim(coalesce(product_code,''))), coalesce(trim_scale(qty)::text,''), coalesce(round(amount,2)::text,''), coalesce(round(commission,2)::text,'')),
             ',' order by concat_ws('|', upper(regexp_replace(coalesce(customer_name,''),'[^A-Za-z0-9]','','g')), upper(btrim(coalesce(invoice_no,''))),
             upper(btrim(coalesce(product_code,''))), coalesce(trim_scale(qty)::text,''), coalesce(round(amount,2)::text,''), coalesce(round(commission,2)::text,'')))) as sha
  from monthly_sales
  where source = 'commission' or (source is null and external_ref is null)
  group by 1,2,3
)
select manufacturer, to_char(period,'YYYY-MM') as month, count(*) as files,
       jsonb_agg(jsonb_build_object('file',file,'rows',rows,'commission',commission) order by file) as detail,
       count(distinct sha) < count(*) as has_identical_files,
       case when count(distinct sha) < count(*) then 'BLOCKED: identical statement loaded twice'
            else 'REVIEW: more than one file for the month' end as verdict
from f group by 1,2 having count(*) > 1
order by verdict, manufacturer, month;
