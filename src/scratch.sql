select index, percent_rank() over (order by value asc) value
from file('../www/data/h3_data.csv', CSVWithNames, 'index String, value Float64')
into outfile '../www/data/h3_data.arrow' truncate compression 'none' settings output_format_arrow_compression_method = 'none'
-- the neat thing here is if we attached it to the server with a bbox we could automatically quantilify whatever was on the screen
