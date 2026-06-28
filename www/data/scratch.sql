-- clickhouse-local
-- really this stuff ought to be done in julia

create table cartogram
engine = Memory
as
select x,y,weight,population,code,label,index from 'cartogram.arrow'
order by x,y

select c.*, (c.weight*c.population)/p.population weight_mean from cartogram c
left join (
    select x,y,sum(weight*population) population
    from cartogram
    group by x,y
) p on p.x = c.x and p.y = c.y
into outfile 'cartogram_weights.arrow' settings output_format_arrow_compression_method = 'none'


select floor(value, 1) flv, round(min(median))
from 'out_string_quantile.arrow'
group by flv
order by flv asc
format csv

select median as value, index from 'out_string_quantile.arrow'
into outfile 'population_density.arrow' settings output_format_arrow_compression_method = 'none'
