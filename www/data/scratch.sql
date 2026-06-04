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
