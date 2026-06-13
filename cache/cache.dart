import 'package:redis_plus/redis_plus.dart';
import '../config/config.dart';

class Cache {
  late final RedisClient _client;

  Future<void> connect() async {
    final config = Config();
    _client = await RedisClient.connect(
      host: config.redisHost,
      port: config.redisPort,
    );
  }

  Future<String?> get(String key) async {
    return await _client.get(key);
  }

  Future<void> set(String key, String value, {Duration? ttl}) async {
    if (ttl != null) {
      await _client.setex(key, ttl.inSeconds, value);
    } else {
      await _client.set(key, value);
    }
  }

  Future<void> delete(String key) async {
    await _client.del(key);
  }

  Future<void> close() async {
    await _client.close();
  }
}
