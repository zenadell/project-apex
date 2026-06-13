import 'package:postgres/postgres.dart';
import '../config/config.dart';

class Database {
  late final PostgreSQLConnection _connection;

  Future<void> connect() async {
    final config = Config();
    _connection = PostgreSQLConnection(
      config.dbUrl,
      1, // timeout in seconds
    );
    await _connection.open();
  }

  Future<List<Map<String, Map<String, dynamic>>>> query(
    String sql, {
    Map<String, dynamic>? substitutionValues,
  }) async {
    return await _connection.query(sql, substitutionValues: substitutionValues);
  }

  Future<void> close() async {
    await _connection.close();
  }
}
