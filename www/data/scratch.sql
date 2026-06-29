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

-- add split int for h3 zero-copy
select * except (index, h3) from (
    select *, reinterpretAsUInt64(reverse(unhex(index))) h3,
    toUInt32(bitAnd(h3, toUInt64(4294967295))) as index_lower,
    toUInt32(bitShiftRight(h3, 32)) as index_upper
    -- bitOr(toUInt64(index_lower), bitShiftLeft(toUInt64(index_upper),32)) -- validation
    from 'cartogram_weights.arrow'
)
into outfile 'cartogram_weights_hilo.arrow' settings output_format_arrow_compression_method = 'none'

select * except (index, h3) from (
    select *, reinterpretAsUInt64(reverse(unhex(index))) h3,
    toUInt32(bitAnd(h3, toUInt64(4294967295))) as index_lower,
    toUInt32(bitShiftRight(h3, 32)) as index_upper
    -- bitOr(toUInt64(index_lower), bitShiftLeft(toUInt64(index_upper),32)) -- validation
    from 'population_density.arrow'
)
into outfile 'population_density_hilo.arrow' settings output_format_arrow_compression_method = 'none'
