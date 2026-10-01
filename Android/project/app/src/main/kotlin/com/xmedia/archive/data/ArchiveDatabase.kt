package com.xmedia.archive.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(entities = [JobEntity::class, MediaEntity::class, TweetCategoryEntity::class, TweetCategoryAssignmentEntity::class], version = 2, exportSchema = false)
abstract class ArchiveDatabase : RoomDatabase() {
    abstract fun dao(): ArchiveDao

    companion object {
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("CREATE TABLE IF NOT EXISTS `tweet_categories` (`id` TEXT NOT NULL, `name` TEXT NOT NULL, `normalizedName` TEXT NOT NULL, `createdAt` TEXT NOT NULL, PRIMARY KEY(`id`))")
                database.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_tweet_categories_normalizedName` ON `tweet_categories` (`normalizedName`)")
                database.execSQL("CREATE TABLE IF NOT EXISTS `tweet_category_assignments` (`tweetId` TEXT NOT NULL, `categoryId` TEXT NOT NULL, PRIMARY KEY(`tweetId`, `categoryId`), FOREIGN KEY(`categoryId`) REFERENCES `tweet_categories`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE)")
                database.execSQL("CREATE INDEX IF NOT EXISTS `index_tweet_category_assignments_tweetId` ON `tweet_category_assignments` (`tweetId`)")
                database.execSQL("CREATE INDEX IF NOT EXISTS `index_tweet_category_assignments_categoryId` ON `tweet_category_assignments` (`categoryId`)")
            }
        }

        @Volatile private var instance: ArchiveDatabase? = null

        fun get(context: Context): ArchiveDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext,
                ArchiveDatabase::class.java,
                "x-media-archive.db",
            ).addMigrations(MIGRATION_1_2).build().also { instance = it }
        }
    }
}
