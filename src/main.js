import * as core from '@actions/core';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger, handleError, withRetry, formatDate, IssueManager, ConcurrencyPool } from './utils.js';
import * as github from '@actions/github';
import fs from 'fs';

const RETRY_TIMES = core.getInput('retry_times') || 3;
const POSTS_COUNT = core.getInput('posts_count') || 2;
const DATE_FORMAT = core.getInput('date_format') || 'YYYY-MM-DD HH:mm:ss';
const CONCURRENCY_LIMIT = 10;

async function parseFeed(feedUrl) {
  try {
    const response = await axios.get(feedUrl, { timeout: 5000 });
    const $ = cheerio.load(response.data, { xmlMode: true });
    const posts = [];

    let isRss = false;
    let items = $('feed > entry');
    if (items.length === 0) {
      items = $('rss > channel > item');
      if (items.length > 0) {
        isRss = true;
      }
    }
    logger('info', `Feed URL: ${items.length} isRss: ${isRss}`);

    items.slice(0, POSTS_COUNT).each((i, el) => {
      const $item = $(el);
      const title = $item.find('title').first().text();

      let link;
      if (isRss) {
        link = $item.find('link').first().text();
      } else { // Atom
        link = $item.find('link[rel="alternate"]').attr('href');
        if (!link) {
          link = $item.find('link').attr('href');
        }
      }

      let publishedDateStr;
      if (isRss) {
        publishedDateStr = $item.find('pubDate').first().text();
      } else { // Atom
        publishedDateStr = $item.find('published').first().text();
      }

      const formattedPublished = publishedDateStr ? formatDate(publishedDateStr, DATE_FORMAT) : '';
      logger('info', `Extracted - Title: ${title}, Link: ${link}, Published: ${formattedPublished}`);

      if (title && link) {
        posts.push({ title, link, published: formattedPublished });
      }
    });

    return posts;
  } catch (error) {
    handleError(error, `Error parsing feed from ${feedUrl}`);
    return [];
  }
}

async function processIssue(issue) {
  try {
    logger('info', `Processing issue #${issue.number}`);
    if (!issue.body) {
      logger('warn', `Issue #${issue.number} has no body content, skipping...`);
      return { status: 'error', posts: [], feedUrl: null };
    }

    const match = issue.body.match(/```json\s*\{[\s\S]*?\}\s*```/m);
    const jsonMatch = match ? match[0].match(/\{[\s\S]*\}/m) : null;

    if (!jsonMatch) {
      logger('warn', `No JSON content found in issue #${issue.number}`);
      return { status: 'error', posts: [], feedUrl: null };
    }

    logger('info', `Found JSON content in issue #${issue.number}, jsonMatch[0]: ${jsonMatch[0]}`);
    const jsonData = JSON.parse(jsonMatch[0]);
    logger('info', `Got JSON content in issue #${issue.number}`, jsonData);

    // 获取 feed 数据
    const feedUrl = jsonData.feed;
    let posts = [];
    let status = 'error';
    if (feedUrl) {
      logger('info', `Getting feed data from ${feedUrl}`);
      posts = await withRetry(() => parseFeed(feedUrl), RETRY_TIMES);
      if (posts && posts.length > 0) status = 'active';
    }

    logger('info', `Converted JSON content in issue #${issue.number}`, jsonData);
    const newBody = issue.body.replace(jsonMatch[0], JSON.stringify(jsonData, null, 2));
    return {
      data: jsonData,
      newBody: newBody,
      posts,
      status,
      feedUrl,
      author: jsonData.author || '',
      avatar: jsonData.avatar || ''
    };
  } catch (error) {
    handleError(error, `Error processing issue #${issue.number}`);
    return { status: 'error', posts: [], feedUrl: null };
  }
}

async function run() {
  const token = process.env.GITHUB_TOKEN;
  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;
  const issueManager = new IssueManager(token);

  try {
    logger('info', `>> 开始`);
    const allIssues = await issueManager.getIssues();

    // 获取issue总数
    const friends_num = allIssues.length;
    const pool = new ConcurrencyPool(CONCURRENCY_LIMIT);

    let allArticles = [];
    let active_num = 0;
    let error_num = 0;
    let article_num = 0;

    // 用于统计最后更新时间
    let last_updated_time = '';

    for (const issue of allIssues) {
      await pool.add(async () => {
        const result = await processIssue(issue);
        if (result) {
          active_num++;
          // 更新 issue body
          await issueManager.octokit.issues.update({
            owner,
            repo,
            issue_number: issue.number,
            body: result.newBody
          });
          logger('info', `Updated issue #${issue.number}`);

          // 合并所有文章
          if (result.data && Array.isArray(result.data.posts)) {
            const author = result.data.name || '';
            const avatar = result.data.avatar || '';
            result.data.posts.forEach(post => {
              allArticles.push({
                title: post.title,
                created: post.published,
                link: post.link,
                author,
                avatar
              });
            });
            article_num += result.data.posts.length;
          }
        } else {
          error_num++;
        }
      });
    }

    allArticles.sort((a, b) => new Date(b.created) - new Date(a.created));

    last_updated_time = formatDate(new Date(), DATE_FORMAT);

    const allData = {
      statistical_data: {
        friends_num,
        active_num,
        error_num,
        article_num,
        last_updated_time
      },
      article_data: allArticles
    };

    // 写入 all.json
    fs.writeFileSync('all.json', JSON.stringify(allData, null, 2), 'utf8');
    logger('info', 'all.json 写入完成');

    logger('info', `>> 结束`);
  } catch (error) {
    // handleError(error, 'Error processing issues');
    logger('error', `Error processing issues`);
    process.exit(1);
  }
}

run();