import 'dart:io';
import 'package:test/test.dart';
import 'package:shelf_test/shelf_test.dart';
import 'package:mockito/mockito.dart';
import '../helpers/mocks.dart';
import '../helpers/test_server.dart';
import '../fixtures/valid_jwt.dart';
import '../fixtures/invalid_jwt.dart';
import '../../config/config.dart';

void main() {
  late MockDatabase db;
  late MockCache cache;
  late MockCodeAgent agent;
  late Handler handler;

  setUpAll(() {
    Platform.environment['JWT_SECRET'] = 'test_secret';
    Config().load();
  });

  setUp(() {
    db = MockDatabase();
    cache = MockCache();
    agent = MockCodeAgent();
    handler = createTestHandler(db: db, cache: cache, agent: agent);
  });

  group('POST /api/capture', () {
    test('returns 200 with valid auth and body', () async {
      when(db.query(any, substitutionValues: anyNamed('substitutionValues')))
          .thenAnswer((_) async => [{'id': 1}]);
      when(cache.set(any, any, ttl: anyNamed('ttl'))).thenAnswer((_) async => null);

      final client = TestClient(handler);
      final response = await client.post(
        '/api/capture',
        headers: {
          'Authorization': 'Bearer $validJwt',
          'Content-Type': 'application/json',
        },
        body: '{"camera_id":"cam1"}',
      );
      expect(response.statusCode, 200);
      final body = await response.readAsString();
      expect(body, contains('"request_id"'));
    });

    test('returns 401 without auth header', () async {
      final client = TestClient(handler);
      final response = await client.post(
        '/api/capture',
        headers: {'Content-Type': 'application/json'},
        body: '{"camera_id":"cam1"}',
      );
      expect(response.statusCode, 401);
    });

    test('returns 401 with invalid JWT', () async {
      final client = TestClient(handler);
      final response = await client.post(
        '/api/capture',
        headers: {
          'Authorization': 'Bearer $invalidJwt',
          'Content-Type': 'application/json',
        },
        body: '{"camera_id":"cam1"}',
      );
      expect(response.statusCode, 401);
    });

    test('returns 400 when camera_id missing', () async {
      final client = TestClient(handler);
      final response = await client.post(
        '/api/capture',
        headers: {
          'Authorization': 'Bearer $validJwt',
          'Content-Type': 'application/json',
        },
        body: '{}',
      );
      expect(response.statusCode, 400);
    });

    test('returns 429 when rate limit exceeded', () async {
      when(cache.get(any)).thenAnswer((_) async => '10');
      when(cache.set(any, any, ttl: anyNamed('ttl'))).thenAnswer((_) async => null);

      final client = TestClient(handler);
      final response = await client.post(
        '/api/capture',
        headers: {
          'Authorization': 'Bearer $validJwt',
          'Content-Type': 'application/json',
        },
        body: '{"camera_id":"cam1"}',
      );
      expect(response.statusCode, 429);
    });

    test('calls DB and cache on success', () async {
      when(db.query(any, substitutionValues: anyNamed('substitutionValues')))
          .thenAnswer((_) async => [{'id': 2}]);
      when(cache.set(any, any, ttl: anyNamed('ttl'))).thenAnswer((_) async => null);

      final client = TestClient(handler);
      await client.post(
        '/api/capture',
        headers: {
          'Authorization': 'Bearer $validJwt',
          'Content-Type': 'application/json',
        },
        body: '{"camera_id":"cam1"}',
      );
      verify(db.query(any, substitutionValues: anyNamed('substitutionValues'))).called(1);
      verify(cache.set(any, any, ttl: anyNamed('ttl'))).called(1);
    });
  });
}
