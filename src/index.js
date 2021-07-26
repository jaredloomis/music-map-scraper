const cheerio = require('cheerio');
const fetch = require('node-fetch');
const {Database, aqlQuery} = require('arangojs');

const db = new Database({
  "databaseName": 'music',
  "url": "http://localhost:8529",
  auth: { username: "jared", password: "igotthatpma12" },
});

async function getRelatedBands(bandName) {
  const id = bandName.toLowerCase().replace(" ", "+");
  let ret;
  try {
    ret = await fetch(`https://music-map.com/${id}`);
  } catch(ex) {
    console.error("Failed to fetch artists similar to " + bandName);
    return [];
  }
  const $ = cheerio.load(await ret.text());
  const bands = [...$("#gnodMap > a.S")].map(x => x.children[0].data);
  const related = bands.filter(n => n !== bandName);
  console.log(`related to ${bandName}:`, related);
  return related;
}

async function addRelated(band, related) {
  if(related.length == 0) {
    return;
  }

  try {
    // Log that we've already searched music-map for this artist
    // (insert artist if not already present)
    console.log("Inserting initial artist...");
    let cursor = await db.query({
      query: `
        UPSERT { normName: LOWER(@band) }
        INSERT { name: @band, normName: LOWER(@band), searchedMusicMap: true }
        UPDATE { searchedMusicMap: true }
        IN artists
        RETURN { doc: NEW, type: OLD ? 'update' : 'insert' }
      `,
      bindVars: { band },
    });
    const bandObj = (await cursor.map(doc => doc.doc))[0];
    console.log("BAND KEY:", bandObj._key);

    if(!bandObj) {
      throw "bandObj is null - error in inserting artist.";
    }

    // Create documents for each related band
    console.log("Inserting related artists...");
    cursor = await db.query({
      query: `
        FOR band IN @bands
          UPSERT { normName: LOWER(band) }
          INSERT { name: band, normName: LOWER(band) }
          UPDATE OLD
          IN artists
          RETURN { doc: NEW, type: OLD ? 'update' : 'insert' }
      `,
      bindVars: { bands: related },
    });
    const relatedObjs = await cursor.map(doc => doc.doc);

    if(!relatedObjs || relatedObjs.length !== related.length) {
      throw "error inserting related artists.";
    }

    // Insert edges
    console.log("Inserting edges...");
    const insertedEdges = [];
    for(relatedObj of relatedObjs) {
      if(relatedObj._id !== band._id) {
        cursor = await db.query({
          query: `
            INSERT {
              _from: @bandID,
              _to: @relatedID,
              name: @bandKey
            } IN musicMapSimilar
            RETURN NEW
          `,
          bindVars: { relatedID: relatedObj._id, bandID: bandObj._id, bandKey: bandObj._key },
        });
        insertedEdges.push(...[...(await cursor.map(x => x))])
      }
    }
    return insertedEdges;
  } catch(ex) {
    console.log("ERROR:", ex);
  }
}

async function getUnsearchedArtists() {
  const cursor = await db.query(`
      FOR a IN artists
        FILTER !a.searchedMusicMap
        RETURN a
    `);
  const ret = await cursor.map(doc => doc);
  return ret;
}

(async function() {
  const command = process.argv[2];
  if(command === "expand" || !command) {
    for(artist of await getUnsearchedArtists()) {
      console.log(artist.name);
      await addRelated(artist.name, await getRelatedBands(artist.name));
    }
  } else if(command === "fetch") {
    const artist = process.argv[3];
    console.log(await addRelated(artist, await getRelatedBands(artist)));
  } else {
    console.error(`Command not found: ${command}. Commands: expand, fetch.`);
  }
})();
