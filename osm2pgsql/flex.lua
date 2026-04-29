local srid = 3857

local roads = osm2pgsql.define_way_table('osm_roads', {
  { column = 'osm_id', type = 'bigint' },
  { column = 'class', type = 'text' },
  { column = 'name', type = 'text' },
  { column = 'ref', type = 'text' },
  { column = 'layer', type = 'int' },
  { column = 'tunnel', type = 'bool' },
  { column = 'bridge', type = 'bool' },
  { column = 'geom', type = 'linestring', projection = srid },
})

local water = osm2pgsql.define_area_table('osm_water', {
  { column = 'osm_id', type = 'bigint' },
  { column = 'class', type = 'text' },
  { column = 'name', type = 'text' },
  { column = 'geom', type = 'multipolygon', projection = srid },
})

local landuse = osm2pgsql.define_area_table('osm_landuse', {
  { column = 'osm_id', type = 'bigint' },
  { column = 'class', type = 'text' },
  { column = 'name', type = 'text' },
  { column = 'geom', type = 'multipolygon', projection = srid },
})

local buildings = osm2pgsql.define_area_table('osm_buildings', {
  { column = 'osm_id', type = 'bigint' },
  { column = 'class', type = 'text' },
  { column = 'name', type = 'text' },
  { column = 'house_number', type = 'text' },
  { column = 'height', type = 'real' },
  { column = 'geom', type = 'multipolygon', projection = srid },
})

local addresses = osm2pgsql.define_node_table('osm_addresses', {
  { column = 'osm_id', type = 'bigint' },
  { column = 'name', type = 'text' },
  { column = 'house_number', type = 'text' },
  { column = 'street', type = 'text' },
  { column = 'unit', type = 'text' },
  { column = 'geom', type = 'point', projection = srid },
})

local places = osm2pgsql.define_node_table('osm_places', {
  { column = 'osm_id', type = 'bigint' },
  { column = 'class', type = 'text' },
  { column = 'name', type = 'text' },
  { column = 'population', type = 'int' },
  { column = 'geom', type = 'point', projection = srid },
})

local pois = osm2pgsql.define_node_table('osm_pois', {
  { column = 'osm_id', type = 'bigint' },
  { column = 'source', type = 'text' },
  { column = 'class', type = 'text' },
  { column = 'name', type = 'text' },
  { column = 'geom', type = 'point', projection = srid },
})

local boundaries = osm2pgsql.define_relation_table('osm_boundaries', {
  { column = 'osm_id', type = 'bigint' },
  { column = 'admin_level', type = 'int' },
  { column = 'name', type = 'text' },
  { column = 'geom', type = 'multilinestring', projection = srid },
})

local function as_bool(value)
  return value == 'yes' or value == 'true' or value == '1'
end

local function as_int(value)
  if value == nil then return nil end
  return tonumber(value)
end

local function parse_height(value)
  if value == nil then return nil end
  local number = string.match(value, '([0-9%.]+)')
  if number == nil then return nil end
  return tonumber(number)
end

local amenity_pois = {
  arts_centre = true,
  bank = true,
  bar = true,
  biergarten = true,
  cafe = true,
  cinema = true,
  clinic = true,
  college = true,
  community_centre = true,
  courthouse = true,
  doctors = true,
  fast_food = true,
  fire_station = true,
  fuel = true,
  hospital = true,
  library = true,
  marketplace = true,
  pharmacy = true,
  place_of_worship = true,
  police = true,
  post_office = true,
  pub = true,
  restaurant = true,
  school = true,
  theatre = true,
  townhall = true,
  university = true,
}

local tourism_pois = {
  aquarium = true,
  attraction = true,
  camp_site = true,
  caravan_site = true,
  gallery = true,
  guest_house = true,
  hostel = true,
  hotel = true,
  information = true,
  motel = true,
  museum = true,
  theme_park = true,
  viewpoint = true,
  zoo = true,
}

local leisure_pois = {
  fitness_centre = true,
  golf_course = true,
  playground = true,
  sports_centre = true,
  stadium = true,
  swimming_pool = true,
}

local function poi_source_and_class(tags)
  if tags.tourism and tourism_pois[tags.tourism] then
    return 'tourism', tags.tourism
  end
  if tags.amenity and amenity_pois[tags.amenity] then
    return 'amenity', tags.amenity
  end
  if tags.leisure and leisure_pois[tags.leisure] then
    return 'leisure', tags.leisure
  end
  if tags.shop and tags.shop ~= 'no' and tags.shop ~= 'vacant' then
    return 'shop', tags.shop
  end
  return nil, nil
end

function osm2pgsql.process_way(object)
  local highway = object.tags.highway
  if highway then
    roads:insert({
      osm_id = object.id,
      class = highway,
      name = object.tags.name,
      ref = object.tags.ref,
      layer = as_int(object.tags.layer),
      tunnel = as_bool(object.tags.tunnel),
      bridge = as_bool(object.tags.bridge),
      geom = object:as_linestring()
    })
  end

  local natural = object.tags.natural
  local waterway = object.tags.waterway
  local landuse_tag = object.tags.landuse
  local leisure = object.tags.leisure

  if natural == 'water' or waterway == 'riverbank' then
    water:insert({
      osm_id = object.id,
      class = object.tags.water or waterway or natural,
      name = object.tags.name,
      geom = object:as_multipolygon()
    })
    return
  end

  if object.tags.building then
    buildings:insert({
      osm_id = object.id,
      class = object.tags.building,
      name = object.tags.name,
      house_number = object.tags["addr:housenumber"],
      height = parse_height(object.tags.height),
      geom = object:as_multipolygon()
    })
    return
  end

  if landuse_tag or leisure == 'park' or natural == 'wood' then
    landuse:insert({
      osm_id = object.id,
      class = landuse_tag or leisure or natural,
      name = object.tags.name,
      geom = object:as_multipolygon()
    })
  end
end

function osm2pgsql.process_node(object)
  if object.tags["addr:housenumber"] then
    addresses:insert({
      osm_id = object.id,
      name = object.tags.name,
      house_number = object.tags["addr:housenumber"],
      street = object.tags["addr:street"],
      unit = object.tags["addr:unit"],
      geom = object:as_point()
    })
  end

  local place = object.tags.place
  if place and object.tags.name then
    places:insert({
      osm_id = object.id,
      class = place,
      name = object.tags.name,
      population = as_int(object.tags.population),
      geom = object:as_point()
    })
  end

  if object.tags.name then
    local source, class = poi_source_and_class(object.tags)
    if source then
      pois:insert({
        osm_id = object.id,
        source = source,
        class = class,
        name = object.tags.name,
        geom = object:as_point()
      })
    end
  end
end

function osm2pgsql.process_relation(object)
  if object.tags.boundary == 'administrative' then
    boundaries:insert({
      osm_id = object.id,
      admin_level = as_int(object.tags.admin_level),
      name = object.tags.name,
      geom = object:as_multilinestring()
    })
  end
end
