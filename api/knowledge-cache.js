// api/knowledge-cache.js - Simple Knowledge Base Cache
export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }
  
    try {
      const { action, messageText, response } = req.method === 'GET' ? req.query : req.body;
  
      switch (action) {
        case 'check':
          return await checkKnowledgeCache(res, messageText);
        
        case 'store':
          return await storeKnowledgeCache(res, messageText, response);
          
        case 'stats':
          return await getCacheStats(res);
          
        default:
          return res.status(400).json({ error: 'Invalid action' });
      }
    } catch (error) {
      console.error('Knowledge Cache Error:', error);
      return res.status(500).json({ 
        error: 'Cache service error',
        details: error.message 
      });
    }
  }
  
  // Helper function for Redis calls
  async function redisCall(command, ...args) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    
    if (!url || !token) {
      throw new Error('Redis credentials not configured');
    }
  
    const response = await fetch(`${url}/${command}/${args.join('/')}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
  
    if (!response.ok) {
      throw new Error(`Redis error: ${response.statusText}`);
    }
  
    const data = await response.json();
    return data.result;
  }
  
  // Normalize Thai text for better matching
  function normalizeText(text) {
    return text.toLowerCase()
      .replace(/[^\u0E00-\u0E7Fa-zA-Z0-9\s]/g, '') // Keep Thai, English, numbers
      .replace(/\s+/g, ' ')
      .trim();
  }
  
  // Generate cache key from question
  function generateCacheKey(messageText) {
    const normalized = normalizeText(messageText);
    
    // Extract key words (remove common words)
    const commonWords = ['คือ', 'อะไร', 'ยังไง', 'ทำ', 'ได้', 'ไหม', 'มี', 'จะ', 'แล้ว', 'นะ', 'ค่ะ', 'ครับ'];
    const words = normalized.split(' ')
      .filter(word => word.length > 1 && !commonWords.includes(word))
      .slice(0, 4); // Take first 4 meaningful words
    
    return words.join('_');
  }
  
  // Check if similar question exists in cache
  async function checkKnowledgeCache(res, messageText) {
    if (!messageText) {
      return res.status(400).json({ error: 'messageText is required' });
    }
  
    try {
      const cacheKey = generateCacheKey(messageText);
      const exactKey = `knowledge:${cacheKey}`;
      
      // Check exact match first
      const exactMatch = await redisCall('GET', exactKey);
      if (exactMatch) {
        const data = JSON.parse(exactMatch);
        
        // Update usage count
        await redisCall('HINCRBY', exactKey + ':meta', 'usage_count', 1);
        await redisCall('INCR', 'stats:cache_hits');
        
        return res.json({
          hit: true,
          type: 'exact',
          data: data,
          cache_key: cacheKey,
          source: 'redis_exact_match'
        });
      }
      
      // Look for similar questions
      const similarMatch = await findSimilarQuestion(messageText, cacheKey);
      if (similarMatch) {
        await redisCall('INCR', 'stats:similar_hits');
        
        return res.json({
          hit: true,
          type: 'similar',
          data: similarMatch,
          cache_key: cacheKey,
          source: 'redis_similar_match'
        });
      }
      
      // No match found
      await redisCall('INCR', 'stats:cache_misses');
      return res.json({
        hit: false,
        cache_key: cacheKey,
        message: 'No cached answer found'
      });
      
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
  
  // Store Q&A in cache
  async function storeKnowledgeCache(res, messageText, responseText) {
    if (!messageText || !responseText) {
      return res.status(400).json({ error: 'messageText and response are required' });
    }
  
    try {
      const cacheKey = generateCacheKey(messageText);
      const key = `knowledge:${cacheKey}`;
      const ttl = 7200; // 2 hours
      
      const cacheData = {
        question: messageText,
        response: responseText,
        cache_key: cacheKey,
        created_at: new Date().toISOString(),
        ttl: ttl
      };
      
      // Store the Q&A
      await redisCall('SETEX', key, ttl, JSON.stringify(cacheData));
      
      // Store metadata
      await redisCall('HSET', key + ':meta', 'usage_count', 1);
      await redisCall('HSET', key + ':meta', 'created_at', cacheData.created_at);
      await redisCall('EXPIRE', key + ':meta', ttl);
      
      // Track popular topics
      await redisCall('ZINCRBY', 'popular:topics', 1, cacheKey);
      
      // Update stats
      await redisCall('INCR', 'stats:questions_stored');
      
      return res.json({
        success: true,
        cache_key: cacheKey,
        stored_at: cacheData.created_at,
        ttl: ttl
      });
      
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
  
  // Find similar questions (basic similarity)
  async function findSimilarQuestion(messageText, currentKey) {
    try {
      // Get popular topics to check against
      const popularTopics = await redisCall('ZREVRANGE', 'popular:topics', 0, 20);
      
      const currentWords = currentKey.split('_');
      
      for (const topic of popularTopics) {
        if (topic === currentKey) continue; // Skip exact same
        
        const topicWords = topic.split('_');
        
        // Calculate word overlap
        const overlap = currentWords.filter(word => topicWords.includes(word));
        const similarity = overlap.length / Math.max(currentWords.length, topicWords.length);
        
        // If similarity > 50%, consider it similar
        if (similarity > 0.5) {
          const cachedData = await redisCall('GET', `knowledge:${topic}`);
          if (cachedData) {
            const parsed = JSON.parse(cachedData);
            parsed.similarity_score = similarity;
            parsed.matched_topic = topic;
            return parsed;
          }
        }
      }
      
      return null;
    } catch (error) {
      console.error('Similarity search error:', error);
      return null;
    }
  }
  
  // Get cache statistics
  async function getCacheStats(res) {
    try {
      const stats = {
        cache_hits: await redisCall('GET', 'stats:cache_hits') || 0,
        similar_hits: await redisCall('GET', 'stats:similar_hits') || 0,
        cache_misses: await redisCall('GET', 'stats:cache_misses') || 0,
        questions_stored: await redisCall('GET', 'stats:questions_stored') || 0,
        popular_topics: []
      };
      
      // Get popular topics
      const topTopics = await redisCall('ZREVRANGE', 'popular:topics', 0, 9, 'WITHSCORES');
      for (let i = 0; i < topTopics.length; i += 2) {
        stats.popular_topics.push({
          topic: topTopics[i],
          count: parseInt(topTopics[i + 1])
        });
      }
      
      // Calculate hit rate
      const totalRequests = parseInt(stats.cache_hits) + parseInt(stats.similar_hits) + parseInt(stats.cache_misses);
      stats.hit_rate = totalRequests > 0 ? 
        (((parseInt(stats.cache_hits) + parseInt(stats.similar_hits)) / totalRequests) * 100).toFixed(2) : 0;
      
      stats.last_updated = new Date().toISOString();
      
      return res.json(stats);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }