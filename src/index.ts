import { Hono } from 'hono';
import {
	OrganicResult, // Import the result types you need
	DictionaryResult,
	ResultTypes,
	TimeResult,
	KnowledgePanelResult,
	searchWithPages,
	DictionaryResultNode,
	KnowledgePanelResultNode,
	OrganicResultNode,
	TimeResultNode, // Import to filter results by type
} from 'google-sr';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { CheerioAPI } from 'cheerio';

const app = new Hono();

// Redirect root URL
// Throw error
app.get('/', (c) => c.notFound());

app.get('/search', async (c) => {
	const keyword = c.req.query('keyword');
	const count = c.req.query('count') || '10';
	if (!keyword) {
		return c.json({ error: 'No keyword provided' });
	}

	let queryResults: NonNullable<OrganicResultNode | DictionaryResultNode | TimeResultNode | KnowledgePanelResultNode | null>[] = [];

	let currentPage = 1;

	let errorCount = 0;

	while (queryResults.length < parseInt(count)) {
		try {
			const queryResult = await searchWithPages({
				query: keyword,
				// Specify the result types explicitly ([OrganicResult] is the default, but it is recommended to always specify the result type)
				resultTypes: [OrganicResult, DictionaryResult, TimeResult, KnowledgePanelResult],
				// Optional: Customize the request using AxiosRequestConfig (e.g., enabling safe search)
				requestConfig: {
					params: {
						safe: 'active', // Enable "safe mode"
					},
				},
				pages: [currentPage++],
			});

			queryResults = queryResults.concat(queryResult[0]);
		} catch (e) {
			errorCount++;
			console.log(e);

			if (errorCount > 2) {
				break;
			}
		}
	}

	const finalResults = queryResults
		.map((result) => {
			if (result.type === ResultTypes.OrganicResult) {
				return {
					title: result.title,
					url: result.link || `https://google.com/search?q=${keyword}`,
					description: result.description,
				};
			} else if (result.type === ResultTypes.DictionaryResult) {
				return {
					title: result.word,
					url: `https://google.com/search?q=${keyword}`,
					description: result.phonetic + ' ' + result.meanings.join(' '),
				};
			} else if (result.type === ResultTypes.TimeResult) {
				return {
					title: keyword,
					url: `https://google.com/search?q=${keyword}`,
					description: result.time + ' ' + result.timeInWords + ' ' + result.location,
				};
			} else if (result.type === ResultTypes.KnowledgePanelResult) {
				return {
					url: `https://google.com/search?q=${keyword}`,
					title: result.title,
					description: [
						result.description,
						result.label,
						result.metadata.map((metadata) => metadata.label + ': ' + metadata.value).join('\n'),
					].join('\n'),
				};
			}
		})
		.filter((result) => result != null);

	return c.json(
		await Promise.all(
			finalResults.map(async (result) => {
				if (result.url?.startsWith(`https://google.com/search?q=${keyword}`)) {
					return result;
				}

				const description = await fetchAndExtractMainContent(result.url || '').then((res) => res.paragraphs.join('\n'));

				if (description) {
					return {
						...result,
						description: description.substring(0, 350),
					};
				}

				return result;
			})
		)
	);
});

function calculateContentScore($element: cheerio.Cheerio<AnyNode>, $: CheerioAPI): number {
	// 基础文本分析
	const text = $element.text().trim();
	const textLength = text.length;
	if (textLength < 50) return 0; // 过滤短文本噪声

	// HTML结构分析
	const html = $element.html()?.replace(/\s+/g, '') || ''; // 压缩HTML结构
	const htmlLength = html.length;
	const textDensity = textLength / (htmlLength || 1); // 真实文本密度

	// 多空格分析，空格太多，可能是广告
	const spaceRatio = (html.match(/\s{2,}/g) || []).reduce((acc, cur) => acc + cur.length, 0) / textLength;

	// 链接分析
	const linkText = $element.find('a').text().trim();
	const linkDensity = linkText.length / (textLength || 1);

	// 语义特征分析
	const tagName = $element.prop('tagName')?.toLowerCase() || '';
	const semanticBonus = ['article', 'main', 'content'].includes(tagName) ? 0.2 : 0;

	// 上下文特征分析
	const classId = ($element.attr('class') || '') + ($element.attr('id') || '');
	const negativePattern = /(footer|header|nav|menu|sidebar|comment|广告)/i;
	if (negativePattern.test(classId)) return 0;

	// 语言学特征分析
	const cjkRatio = (text.match(/[\u4e00-\u9fa5]/g) || []).length / textLength;
	const punctuationDensity = (text.match(/[。.?!；;]/g) || []).length / textLength;

	// 结构特征分析
	const headingScore = Math.min($element.find('h1,h2,h3').length * 0.1, 0.3);
	const paragraphScore = Math.min($element.find('p').length * 0.05, 0.2);

	// 综合评分公式
	return (
		textDensity * 3 +
		cjkRatio * 0.5 +
		punctuationDensity * 2 -
		linkDensity * 2 +
		semanticBonus +
		headingScore +
		paragraphScore -
		spaceRatio * 2
	);
}

function findMainContent($: CheerioAPI) {
	const candidateSelector = [
		'article',
		'main',
		'.content',
		'#content',
		'section',
		'div[itemprop="articleBody"]',
		'div.content',
		'div.post',
	].join(',');

	let bestElement = $('body');
	let maxScore = 0;

	// 移除 script、style、a 等标签
	$('script, style, a, iframe, noscript').remove();

	// 优先语义化标签
	$(candidateSelector).each((_, element) => {
		const $element = $(element);
		const score = calculateContentScore($element as cheerio.Cheerio<AnyNode>, $);

		if (score > maxScore) {
			maxScore = score;
			bestElement = $element as typeof bestElement;
		}
	});

	// 后备策略：层级遍历
	if (maxScore < 1) {
		$('body:not(style):not(script):not(svg)').each((_, element) => {
			const $element = $(element);
			const score = calculateContentScore($element, $);

			if (score > maxScore) {
				maxScore = score;
				bestElement = $element;
			}
		});
	}

	// 向上溯源
	let parent = bestElement.parent();
	while (parent.length && !parent.is('body')) {
		const parentScore = calculateContentScore(parent, $);
		if (parentScore > maxScore * 1.1) {
			// 父级有明显优势时切换
			bestElement = parent;
			maxScore = parentScore;
		}
		parent = parent.parent();
	}

	return bestElement;
}

async function fetchAndExtractMainContent(url: string) {
	try {
		const response = await fetch(url, {
			headers: DEFAULT_HEADERS,
			cf: {
				cacheEverything: true,
				cacheTtl: 86400,
				cacheBy: {
					url: url,
				},
			},
			method: 'GET',
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);

		const $ = cheerio.load(await response.text(), {
			scriptingEnabled: true,
		});
		const mainContent = findMainContent($);

		// 内容后处理
		const rawText = mainContent
			.text()
			.replace(/\s+/g, ' ') // 合并空白
			.replace(/[\u200B-\u200D\uFEFF]/g, '') // 移除零宽字符
			.replace(/复制这段内容|打开APP/g, ''); // 过滤常见干扰文本

		// 智能分段
		const paragraphs = rawText
			.split(/\n{2,}|[\u3000\s]{4,}/) // 双换行或四个空格分段
			.map((p) => p.trim())
			.filter((p) => p.length > 50 && !/^[0-9a-zA-Z]+$/.test(p));

		// 质量过滤
		const finalParagraphs = paragraphs.filter((p) => {
			const validPunctuation = p.match(/[。.!?]/g)?.length || 0;
			return validPunctuation > 1 && p.length > 80;
		});

		return { url, paragraphs: finalParagraphs };
	} catch (error) {
		console.error(`Error processing ${url}:`, error);
		return { url, paragraphs: [] };
	}
}

const DEFAULT_HEADERS = {
	Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
	'Accept-Encoding': 'gzip, deflate',
	'Accept-Language': 'en-US,en;q=0.5',
	'Alt-Used': 'LEAVE-THIS-KEY-SET-BY-TOOL',
	Connection: 'keep-alive',
	Host: 'LEAVE-THIS-KEY-SET-BY-TOOL',
	Referer: 'https://www.google.com/',
	'Sec-Fetch-Dest': 'document',
	'Sec-Fetch-Mode': 'navigate',
	'Sec-Fetch-Site': 'cross-site',
	'Upgrade-Insecure-Requests': '1',
	'User-Agent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/111.0',
};

export default app;
