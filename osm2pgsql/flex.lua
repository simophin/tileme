local srid = 3857
local import_name = os.getenv('TILEME_IMPORT_NAME') or 'default'
local table_prefix = os.getenv('TILEME_OSM_TABLE_PREFIX') or 'osm_'

local roads = osm2pgsql.define_way_table(table_prefix .. 'roads', {
  { column = 'import_name', type = 'text' },
  { column = 'osm_id', type = 'bigint' },
  { column = 'class', type = 'text' },
  { column = 'name', type = 'text' },
  { column = 'ref', type = 'text' },
  { column = 'layer', type = 'int' },
  { column = 'tunnel', type = 'bool' },
  { column = 'bridge', type = 'bool' },
  { column = 'tags', type = 'jsonb' },
  { column = 'geom', type = 'linestring', projection = srid },
})

local water = osm2pgsql.define_area_table(table_prefix .. 'water', {
  { column = 'import_name', type = 'text' },
  { column = 'osm_id', type = 'bigint' },
  { column = 'class', type = 'text' },
  { column = 'name', type = 'text' },
  { column = 'tags', type = 'jsonb' },
  { column = 'geom', type = 'multipolygon', projection = srid },
})

local landuse = osm2pgsql.define_area_table(table_prefix .. 'landuse', {
  { column = 'import_name', type = 'text' },
  { column = 'osm_id', type = 'bigint' },
  { column = 'class', type = 'text' },
  { column = 'name', type = 'text' },
  { column = 'tags', type = 'jsonb' },
  { column = 'geom', type = 'multipolygon', projection = srid },
})

local buildings = osm2pgsql.define_area_table(table_prefix .. 'buildings', {
  { column = 'import_name', type = 'text' },
  { column = 'osm_id', type = 'bigint' },
  { column = 'class', type = 'text' },
  { column = 'name', type = 'text' },
  { column = 'house_number', type = 'text' },
  { column = 'height', type = 'real' },
  { column = 'tags', type = 'jsonb' },
  { column = 'geom', type = 'multipolygon', projection = srid },
})

local addresses = osm2pgsql.define_node_table(table_prefix .. 'addresses', {
  { column = 'import_name', type = 'text' },
  { column = 'osm_id', type = 'bigint' },
  { column = 'name', type = 'text' },
  { column = 'house_number', type = 'text' },
  { column = 'street', type = 'text' },
  { column = 'unit', type = 'text' },
  { column = 'suburb', type = 'text' },
  { column = 'city', type = 'text' },
  { column = 'state', type = 'text' },
  { column = 'postcode', type = 'text' },
  { column = 'country', type = 'text' },
  { column = 'tags', type = 'jsonb' },
  { column = 'geom', type = 'point', projection = srid },
})

local places = osm2pgsql.define_node_table(table_prefix .. 'places', {
  { column = 'import_name', type = 'text' },
  { column = 'osm_id', type = 'bigint' },
  { column = 'class', type = 'text' },
  { column = 'name', type = 'text' },
  { column = 'population', type = 'int' },
  { column = 'tags', type = 'jsonb' },
  { column = 'geom', type = 'point', projection = srid },
})

local pois = osm2pgsql.define_node_table(table_prefix .. 'pois', {
  { column = 'import_name', type = 'text' },
  { column = 'osm_id', type = 'bigint' },
  { column = 'source', type = 'text' },
  { column = 'class', type = 'text' },
  { column = 'name', type = 'text' },
  { column = 'tags', type = 'jsonb' },
  { column = 'geom', type = 'point', projection = srid },
})

local boundaries = osm2pgsql.define_relation_table(table_prefix .. 'boundaries', {
  { column = 'import_name', type = 'text' },
  { column = 'osm_id', type = 'bigint' },
  { column = 'admin_level', type = 'int' },
  { column = 'name', type = 'text' },
  { column = 'tags', type = 'jsonb' },
  { column = 'geom', type = 'multilinestring', projection = srid },
})

local admin_areas = osm2pgsql.define_area_table(table_prefix .. 'admin_areas', {
  { column = 'import_name', type = 'text' },
  { column = 'osm_id', type = 'bigint' },
  { column = 'admin_level', type = 'int' },
  { column = 'name', type = 'text' },
  { column = 'tags', type = 'jsonb' },
  { column = 'geom', type = 'multipolygon', projection = srid },
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

local kept_tag_keys = {
  ["access"] = true,
  ["addr:door"] = true,
  ["addr:floor"] = true,
  ["addr:flats"] = true,
  ["addr:full"] = true,
  ["addr:place"] = true,
  ["amenity"] = true,
  ["atm"] = true,
  ["barbecue"] = true,
  ["bicycle"] = true,
  ["brand"] = true,
  ["branch"] = true,
  ["brewery"] = true,
  ["building"] = true,
  ["building:colour"] = true,
  ["building:levels"] = true,
  ["building:material"] = true,
  ["bus"] = true,
  ["contact:email"] = true,
  ["contact:phone"] = true,
  ["contact:website"] = true,
  ["craft"] = true,
  ["cuisine"] = true,
  ["cycleway"] = true,
  ["delivery"] = true,
  ["diet:halal"] = true,
  ["diet:kosher"] = true,
  ["diet:vegan"] = true,
  ["diet:vegetarian"] = true,
  ["dog"] = true,
  ["drinking_water"] = true,
  ["drive_through"] = true,
  ["email"] = true,
  ["fee"] = true,
  ["foot"] = true,
  ["healthcare"] = true,
  ["height"] = true,
  ["heritage"] = true,
  ["historic"] = true,
  ["horse"] = true,
  ["image"] = true,
  ["indoor"] = true,
  ["internet_access"] = true,
  ["lanes"] = true,
  ["leisure"] = true,
  ["level"] = true,
  ["lit"] = true,
  ["mapillary"] = true,
  ["maxspeed"] = true,
  ["min_height"] = true,
  ["mtb:scale"] = true,
  ["natural"] = true,
  ["network"] = true,
  ["office"] = true,
  ["official_name"] = true,
  ["oneway"] = true,
  ["opening_hours"] = true,
  ["operator"] = true,
  ["outdoor_seating"] = true,
  ["parking"] = true,
  ["phone"] = true,
  ["picnic_table"] = true,
  ["playground"] = true,
  ["public_transport"] = true,
  ["railway"] = true,
  ["roof:colour"] = true,
  ["roof:levels"] = true,
  ["roof:shape"] = true,
  ["route_ref"] = true,
  ["sac_scale"] = true,
  ["service"] = true,
  ["shop"] = true,
  ["sidewalk"] = true,
  ["smoking"] = true,
  ["smoothness"] = true,
  ["sport"] = true,
  ["start_date"] = true,
  ["surface"] = true,
  ["takeaway"] = true,
  ["toilets"] = true,
  ["tourism"] = true,
  ["trail_visibility"] = true,
  ["train"] = true,
  ["tram"] = true,
  ["website"] = true,
  ["wheelchair"] = true,
  ["wikidata"] = true,
  ["wikipedia"] = true,
}

local kept_tag_prefixes = {
  "description:",
  "name:",
  "parking:lane:",
}

local function starts_with(value, prefix)
  return string.sub(value, 1, string.len(prefix)) == prefix
end

local function should_keep_tag(key)
  if kept_tag_keys[key] then
    return true
  end

  for _, prefix in ipairs(kept_tag_prefixes) do
    if starts_with(key, prefix) then
      return true
    end
  end

  return false
end

local function kept_tags(tags)
  local result = {}

  for key, value in pairs(tags) do
    if should_keep_tag(key) then
      result[key] = value
    end
  end

  return result
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
      import_name = import_name,
      osm_id = object.id,
      class = highway,
      name = object.tags.name,
      ref = object.tags.ref,
      layer = as_int(object.tags.layer),
      tunnel = as_bool(object.tags.tunnel),
      bridge = as_bool(object.tags.bridge),
      tags = kept_tags(object.tags),
      geom = object:as_linestring()
    })
  end

  local natural = object.tags.natural
  local waterway = object.tags.waterway
  local landuse_tag = object.tags.landuse
  local leisure = object.tags.leisure

  if not object.is_closed then
    return
  end

  if natural == 'water' or waterway == 'riverbank' then
    local geom = object:as_multipolygon()
    if not geom then
      return
    end

    water:insert({
      import_name = import_name,
      osm_id = object.id,
      class = object.tags.water or waterway or natural,
      name = object.tags.name,
      tags = kept_tags(object.tags),
      geom = geom
    })
    return
  end

  if object.tags.building then
    local geom = object:as_multipolygon()
    if not geom then
      return
    end

    buildings:insert({
      import_name = import_name,
      osm_id = object.id,
      class = object.tags.building,
      name = object.tags.name,
      house_number = object.tags["addr:housenumber"],
      height = parse_height(object.tags.height),
      tags = kept_tags(object.tags),
      geom = geom
    })
    return
  end

  if landuse_tag or leisure == 'park' or natural == 'wood' then
    local geom = object:as_multipolygon()
    if not geom then
      return
    end

    landuse:insert({
      import_name = import_name,
      osm_id = object.id,
      class = landuse_tag or leisure or natural,
      name = object.tags.name,
      tags = kept_tags(object.tags),
      geom = geom
    })
  end
end

function osm2pgsql.process_node(object)
  if object.tags["addr:housenumber"] then
    addresses:insert({
      import_name = import_name,
      osm_id = object.id,
      name = object.tags.name,
      house_number = object.tags["addr:housenumber"],
      street = object.tags["addr:street"],
      unit = object.tags["addr:unit"],
      suburb = object.tags["addr:suburb"],
      city = object.tags["addr:city"],
      state = object.tags["addr:state"],
      postcode = object.tags["addr:postcode"],
      country = object.tags["addr:country"],
      tags = kept_tags(object.tags),
      geom = object:as_point()
    })
  end

  local place = object.tags.place
  if place and object.tags.name then
    places:insert({
      import_name = import_name,
      osm_id = object.id,
      class = place,
      name = object.tags.name,
      population = as_int(object.tags.population),
      tags = kept_tags(object.tags),
      geom = object:as_point()
    })
  end

  if object.tags.name then
    local source, class = poi_source_and_class(object.tags)
    if source then
      pois:insert({
        import_name = import_name,
        osm_id = object.id,
        source = source,
        class = class,
        name = object.tags.name,
        tags = kept_tags(object.tags),
        geom = object:as_point()
      })
    end
  end
end

function osm2pgsql.process_relation(object)
  if object.tags.boundary == 'administrative' then
    local admin_level = as_int(object.tags.admin_level)

    boundaries:insert({
      import_name = import_name,
      osm_id = object.id,
      admin_level = admin_level,
      name = object.tags.name,
      tags = kept_tags(object.tags),
      geom = object:as_multilinestring()
    })

    local area_geom = object:as_multipolygon()
    if object.tags.name and admin_level and area_geom then
      admin_areas:insert({
        import_name = import_name,
        osm_id = object.id,
        admin_level = admin_level,
        name = object.tags.name,
        tags = kept_tags(object.tags),
        geom = area_geom
      })
    end
  end
end
