//import Parser from 'rss-parser'
//import { Feed } from 'feed'
import Handlebars from 'handlebars/runtime'
import template from './templates/default.precompiled'
//import * as striptags from 'striptags'
import striptags from 'striptags'
//
///**
// * Extra Handlerbars template helpers
// */
Handlebars.registerHelper('isRowElemN', function(index, rowItems, n, options) {
  return index % rowItems == n ? options.fn(this) : options.inverse(this)
})
//
/*  */
import { Feed } from 'feed'
import { XMLParser } from 'fast-xml-parser';
/**
 * Builds a feed object from the provided items
 * @param {Array} items parsed by rss-parser
 * @return Feed object created by feed
 */
function createFeed(items,env) {
  console.log(`[createFeed] start building the aggregated feed`)
  const feed = new Feed({
    title: env.TITLE|| "MERGED FEED FOR "+env.FEEDS,
    description: env.DESCRIPTION|| "No description provided",
    id:   env.CUSTOM_URL||env.FEEDS.split(",")[0],
    link: env.CUSTOM_URL||env.FEEDS.split(",")[0],
  })

  for (let item of items) {
	let mydesc=item.description||""
    feed.addItem({
      title: item.title,
      id: item.guid["#text"],
      link: item.link,
      description: mydesc,
      content: item.content,
      author: [
        {
          name: item.creator,
          email: '',
          link: item.source_link,
        },
      ],
      contributor: [],
      date: new Date(item.pubDate),
		})
  }
  console.log(`[createFeed] Finished building the aggregated feed`)
  return feed
}
/**
 * Generate the HTML page with the aggregated contents
 * @param {Array} items parsed by rss-parser
 * @returns String with HTML page containing the parsed contents
 */
function createHTML(items, sources,env) {
  console.log(`[createHTML] building the HTML document`)
  let template = Handlebars.templates['default']
  let dateFormatter = new Intl.DateTimeFormat('pt-PT', { timeZone: 'UTC' })
  
  for (let item of items) {
    let shortdescription = striptags(item.content||item.description)
    let endstring=""
    if(shortdescription.length > 666 ) {
      shortdescription=shortdescription.substring(0, 666) +  ' [<a href="'+item.link+'" >...</a>]'
    }
    //console.log(shortdescription)
    item.content =  shortdescription ?  shortdescription  : ''
    item.formattedDate = item.pubDate
      ? dateFormatter.format(new Date(item.pubDate))
      : ''
  }
  
  return template({
    items: items,
    sources: sources,
    page_title: env.TITLE|| "MERGED FEED FOR "+env.FEEDS,
    page_description: env.DESCRIPTION|| "No description provided",
  })
  //return "not implemented"
}

/**
 * Fetch all source feeds and generate the aggregated content
 */
async function handleScheduled(env,ctx) {
  let feeds = env.FEEDS.split(',')
  let content = []
  let sources = []

  let promises = []
  for (let url of feeds) {
    promises.push(fetchAndHydrate(url))
  }
  const results = await Promise.allSettled(promises)

  for (let [index, result] of results.entries()) {
    if (result.status == 'fulfilled') {
		//console.log(result)
      let posts = result.value
      let title = posts[0].source_title
      let link = posts[0].source_link
      let name = title != '' ? title : new URL(link).host
      sources.push({ name, link })
      content.push(...posts)
    } else {
      console.log(`Failed to fetch ${feeds[index]}`)
      console.log(result.reason)
    }
  }

  //sort all the elements chronologically (recent first)
  content.sort((a, b) => {
    let aDate = new Date(a.isoDate)
    let bDate = new Date(b.isoDate)
    if (aDate > bDate) {
      return 1
    } else if (aDate === bDate) {
      return 0
    } else {
      return -1
    }
  })

  if (content.length > env.MAX_SIZE) {
    content = content.slice(0, env.MAX_SIZE)
  }

  // Generate feed
  let feed = createFeed(content,env)
  let html = createHTML(content, sources,env)
  // Store
  //console.log(feed.rss2())
  //console.log(html)
  
  ctx.waitUntil(await env.RSS_STORE.put('rss', await feed.rss2()));

  //await env.RSS_STORE.put('atom', feed.atom1())
  ctx.waitUntil(await env.RSS_STORE.put('html',await  html));

  
  console.log("cron done")
}


	
/**
 * Take a feed URL, fetch all items and attach source information
 * @param {String} feed The URL of the feed to be fetched and parsed
 * @returns Array containing all the feed items parsed by rss-parser
 */
async function fetchAndHydrate(feed) {
  console.log(`[fetchAndHydrate] start to fetch feed: ${feed}`)
  let resp = await fetch(feed)
  console.log(`[fetchAndHydrate] response: ${resp.status}`)
  //let parser = new Parser()
  const options = {
  	ignoreAttributes:false
  }
  const parser = new XMLParser(options);
  let content = await resp.text()
  //let contentFeed = await parser.parseString(content)
  let contentFeed = await parser.parse(content)
  
  //console.log(JSON.stringify(contentFeed,null,2))
  //console.log(JSON.stringify(contentFeed.rss.channel.item,null,2))

  for (let item of contentFeed.rss.channel.item) {
    item.source_title = contentFeed.rss.channel.title
    item.source_link = contentFeed.rss.channel.link
    if ('content:encoded' in item) {
      item.content = item['content:encoded']
    }
  }
  console.log(
    `[fetchAndHydrate] Finished fetch feed: ${feed}. ${contentFeed.rss.channel.item.length} items gathered`,
  )
  return contentFeed.rss.channel.item
}
export default {
	// The scheduled handler is invoked at the interval set in our wrangler.toml's
	// [[triggers]] configuration.
  async fetch(request,env, ctx) {
    const cacheUrl = new URL(request.url)
    const cacheKey = new Request(cacheUrl.toString(), request)
    const cache = caches.default
    const cacheMaxAge = env.CACHE_MAX_AGE || 1800
    let response = await cache.match(cacheKey)
    if (response) return response
    const path = new URL(request.url).pathname
    if (path === '/') {
      let content = await env.RSS_STORE.get('html')
      response = new Response(content, {
        headers: {
          'content-type': 'text/html;charset=UTF-8',
          'Cache-Control': `max-age=${cacheMaxAge}`,
        },
      })
    } else if (path === '/rss') {
      let content = await env.RSS_STORE.get('rss')
      response = new Response(content, {
        headers: {
          'content-type': 'application/rss+xml',
          'Cache-Control': `max-age=${cacheMaxAge}`,
        },
      })
    } else if (path === '/atom') {
      let content = await env.RSS_STORE.get('atom')
      response = new Response(content, {
        headers: {
          'content-type': 'application/atom+xml',
          'Cache-Control': `max-age=${cacheMaxAge}`,
        },
      })
    } else {
      return new Response('', { status: 404 })
    }
    	  		 ctx.waitUntil(    await cache.put(cacheKey, response.clone()));

    return response
		
    },
    async scheduled(event,env, ctx) {
	  		 ctx.waitUntil(await handleScheduled(env,ctx));
	},

};
