import 'package:shelf/shelf.dart';
import '../cache/cache.dart';

Middleware rateLimiterMiddleware({int maxRequests = 10, Duration window = const Duration(minutes: 1)}) {
  return (Handler innerHandler) {
    return (Request request) async {
      final ip = request.headers['x-forwarded-for'] ?? request.url.host;
      final key = 'rate_limit:$ip';
      final cache = Cache();
      final current = await cache.get(key);
      int count = current != null ? int.parse(current) : 0;
      if (count >= maxRequests) {
        return Response(429, body: 'Too many requests');
      }
      await cache.set(key, (count + 1).toString(), ttl: window);
      return await innerHandler(request);
    };
  };
}
