import { promisify } from "util";
import { Handler, Context } from 'aws-lambda';
import { Client, QueryResult } from "pg";
import { Projection, WGS84BoundingBox, Tile } from "./projection";
import S3 from 'aws-sdk/clients/s3';
import { gzip } from 'zlib';
import configJSON from './layer.json';

const asyncgzip = promisify(gzip);

interface Event {
    path: string
}

export interface Common {
    extend?: number,
    buffer?: number,
    clip_geom?: boolean,
    geom?: string,
    srid?: number,
    keys?: string[],
    where?: string[],
    minzoom?: number,
    maxzoom?: number,
    postfix?: string,
}

export interface Variants extends Common {
    minzoom: number,
    table?: string
}

export interface Layer extends Common {
    name: string,
    table: string,
    variants?: Variants[]
}

export interface SourceBasics extends Common{
    name: string
}

export interface Source extends SourceBasics {
    name: string,
    layers: Layer[],
    host?: string,
    database?: string,
    port?: number,
}

export interface Config {
    sources: Source[]
}

const config: Config = configJSON;
// const config: Config = {sources: [{minzoom: 2, name:"434", layers:[{name:"eqw", table:"fdf", maxzoom: 2, variants:[{minzoom: 2}]}]}]};

const cacheBucketName = "tiles.cyclemap.link"
const proj = new Projection();
const s3 = new S3({ apiVersion: '2006-03-01' });

/**
 * Extract zxy-tile information from a given path. Also checks for a valid file-extension.
 * @param path a full path including arbitrary prefix-path, layer, tile and extension
 * @return a tile for subsequent use or null if no valid Tile could be extracted. 
 */
export function extractTile(path: string): Tile | null {
    let tile: Tile = { x: 0, y: 0, z: 0 };
    let re = new RegExp(/\d+\/\d+\/\d+(?=.mvt)/g);
    let tilepath = path.match(re);
    if (tilepath) {
        let numbers = tilepath[0].split("/");
        tile.y = parseInt(numbers[numbers.length - 1]);
        tile.x = parseInt(numbers[numbers.length - 2]);
        tile.z = parseInt(numbers[numbers.length - 3]);
        return tile;
    }
    return null;
}


/**
 * Extracts the layer-name from a given path.
 * @param path a full path including arbitrary prefix-path, layer, tile and extension
 * @return the name of the source if found
 */
export function extractSource(path: string): string | null {
    // match the last word between slashes before the actual tile (3-numbers + extension)
    let sourceCandidates: RegExpMatchArray|null = path.match(/(?!\/)\w+(?=\/\d+\/\d+\/\d+\.mvt)/g)
    if (sourceCandidates != null && sourceCandidates.length > 0) {
        return sourceCandidates[sourceCandidates.length - 1];
    }
    return null;
}

/**
 * Check a given layer and variants against the zoom-level. Merge the **last** matching item in the variant-array into the layer and return it.
 * Matching the **last** variant item makes the variant-objects shorter as we don't need to give a maxzoom but use a sequence of minzooms for each variant.
 * @param layer This is the input layer including variants
 * @param zoom The zoom-level to check the layer incl. variants against
 * @return The resulting layer where the **last** matching variant is merged into the layer or null if zoom is out of bounds
 */
export function resolveLayerProperties(layer: Layer, zoom: number): Layer | null {
    let resolved: Layer = layer;

    /** check layer zoom if present */
    if (
        ((layer.minzoom != undefined) && (zoom < layer.minzoom)) ||
        ((layer.maxzoom != undefined) && (zoom >= layer.maxzoom))
     ) {
        return null;
    }

    /* istanbul ignore else */
    if (layer.variants && layer.variants.length) {
        for (let variant of layer.variants) {
            /** the default zoom-values should cover all use-cases on earth */
            let variantMinzoom = (variant.minzoom != undefined) ? variant.minzoom : /* istanbul ignore next: This can't happen due to interface definition */0
            let variantMaxzoom = (variant.maxzoom != undefined) ? variant.maxzoom : 32
            if (zoom >= variantMinzoom && zoom < variantMaxzoom) {
                /** We have a match: merge the variant with the original layer. */
                resolved = { ...layer, ...variant }
            }
        }
    }
    /** do not allow recursive definitions */
    delete resolved.variants;
    return resolved;
}

export function buildLayerQuery(source: SourceBasics, layer: Layer, wgs84BoundingBox: WGS84BoundingBox, zoom: number): string {
    let resolved: Layer | null = resolveLayerProperties(layer, zoom);
    if (resolved === null) return "";

    layer = {...layer, ...resolved};

    let layerExtend: number = (layer.extend != undefined) ? layer.extend : ((source.extend != undefined) ? source.extend : 4096);
    let geom: string = (layer.geom != undefined) ? layer.geom : ((source.geom != undefined) ? source.geom : "geometry");
    let srid: number = (layer.srid != undefined) ? layer.srid : ((source.srid != undefined) ? source.srid : 3857);
    let bbox: string = `ST_Transform(ST_MakeEnvelope(${wgs84BoundingBox.leftbottom.lng}, ${wgs84BoundingBox.leftbottom.lat}, ${wgs84BoundingBox.righttop.lng}, ${wgs84BoundingBox.righttop.lat}, 4326), ${srid})`;
    let buffer: number = (layer.buffer != undefined) ? layer.buffer : ((source.buffer != undefined) ? source.buffer : 256);
    let clip_geom: boolean = (layer.clip_geom != undefined) ? layer.clip_geom : ((source.clip_geom != undefined) ? source.clip_geom : true);
    let postfix: string = (layer.postfix != undefined) ? layer.postfix : ((source.postfix != undefined) ? source.postfix : "");

    let keys: string = "";
    if (source.keys && source.keys.length) {
        keys += ", " + source.keys.join(", ")
    }
    if (layer.keys && layer.keys.length) {
        keys += ", " + layer.keys.join(", ")
    }

    let where: string = "";
    if (source.where && source.where.length) {
        where += " AND (" + source.where.join(") AND (") + ")"
    }
    if (layer.where && layer.where.length) {
        where += " AND (" + layer.where.join(") AND (") + ")"
    }

    return (`(SELECT ST_AsMVT(q, '${layer.name}', ${layerExtend}, 'geom') as data FROM
    (SELECT ST_AsMvtGeom(
        ${geom},
        ${bbox},
        ${layerExtend},
        ${buffer},
        ${clip_geom}
        ) AS geom${keys}
    FROM ${layer.table} WHERE (${geom} && ${bbox})${where}${postfix}) as q)`);
}


function buildQuery(source: string, config: Config, wgs84BoundingBox: WGS84BoundingBox, zoom: number): string | null {
    let query: string | null = null;
    let layerQueries: string[] = [];

    for (let sourceItem of config.sources) {
        if (sourceItem.name === source) {
            for (let layer of sourceItem.layers) {
                let layerQuery: string = buildLayerQuery(sourceItem, layer, wgs84BoundingBox, zoom);
                if (layerQuery.length) layerQueries.push(layerQuery);
            }
        }
    }
    if (layerQueries.length) {
        let layers = layerQueries.join(" || ");
        query = `SELECT ( ${layers} ) as data`;
    }
    else {
        query = `
        SELECT ( (SELECT ST_AsMVT(q, 'empty', 4096, 'geom') as data FROM
        (SELECT ST_AsMvtGeom(
            st_point(0,0),
            ST_MakeEnvelope(0, 1, 1, 0, 4326),
            4096,
            256,
            true
            ) AS geom ) as q) ) as data;        
        `;
    }
    // console.log(layerQueries);
    return query;
}

async function fetchTileFromDatabase(query: string): Promise<Buffer> {
    let client: Client = new Client();
    await client.connect();
    let res: QueryResult = await client.query(query);
    await client.end();
    return res.rows[0].data;
}

export const handler: Handler = async (event: Event, context: Context): Promise<any> => {

    let stats = {
        uncompressedBytes: 0,
        compressedBytes: 0
    }

    let response = {
        statusCode: 500,
        headers: {
            'Content-Type': 'text/html',
            'access-control-allow-origin': '*',
            'Content-Encoding': 'identity',
        },
        body: "Error",
        isBase64Encoded: false
    }

    let tile: Tile | null = extractTile(event.path);
    let source: string | null = extractSource(event.path);

    if (tile && source) {
        let vectortile: Buffer | null = null;

        let wgs84BoundingBox = proj.getWGS84TileBounds(tile)
        let query = buildQuery(source, config, wgs84BoundingBox, tile.z)
        console.log(query);
        if (query) {
            try {
                vectortile = await fetchTileFromDatabase(query);
                stats.uncompressedBytes = vectortile.byteLength;
                vectortile = await <Buffer><unknown>asyncgzip(vectortile);
                stats.compressedBytes = vectortile.byteLength;
                let s3obj = await s3.putObject({
                    Body: vectortile,
                    Bucket: cacheBucketName,
                    Key: `${source}/${tile.z}/${tile.x}/${tile.y}.mvt`,
                    ContentType: "application/vnd.mapbox-vector-tile",
                    ContentEncoding: "gzip",
                    Metadata: {
                        "wgs84BoundingBox": `${wgs84BoundingBox.leftbottom.lng}, ${wgs84BoundingBox.leftbottom.lat}, ${wgs84BoundingBox.righttop.lng}, ${wgs84BoundingBox.righttop.lat}`
                    }
                }).promise();
                // console.log(s3obj);
            } catch (error) {
                vectortile = null;
                console.log(error);
            }
        }
        if (vectortile) {
            response = {
                statusCode: 200,
                headers: {
                    'Content-Type': 'application/vnd.mapbox-vector-tile',
                    'Content-Encoding': 'gzip',
                    'access-control-allow-origin': '*'
                },
                body: vectortile.toString('base64'),
                isBase64Encoded: true
            }
        }
        console.log(`${response.statusCode}: ${source}/${tile.z}/${tile.x}/${tile.y}  ${stats.uncompressedBytes} -> ${stats.compressedBytes}`);
    }
    return Promise.resolve(response)
}