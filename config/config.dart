import 'package:dotenv/dotenv.dart' as dotenv;

class Config {
  static final Config _instance = Config._internal();
  factory Config() => _instance;
  Config._internal();

  late final String dbUrl;
  late final String redisHost;
  late final int redisPort;
  late final String jwtSecret;
  late final int serverPort;

  void load() {
    dotenv.load();
    dbUrl = dotenv.env['DATABASE_URL'] ?? 'postgres://localhost:5432/camera_db';
    redisHost = dotenv.env['REDIS_HOST'] ?? 'localhost';
    redisPort = int.tryParse(dotenv.env['REDIS_PORT'] ?? '6379') ?? 6379;
    jwtSecret = dotenv.env['JWT_SECRET'] ?? 'change_me_in_production';
    serverPort = int.tryParse(dotenv.env['PORT'] ?? '8080') ?? 8080;
  }
}
