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

const app = new Hono();

// Redirect root URL
// Throw error
app.get('/', (c) => c.notFound());

app.get('/search', async (c) => {
	const keyword = c.req.query('keyword');
	const count = c.req.query('count') || '5';
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

	return c.json(
		queryResults.map((result) => {
			if (result.type === ResultTypes.OrganicResult) {
				return {
					title: result.title,
					url: result.link,
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
	);
});

export default app;
